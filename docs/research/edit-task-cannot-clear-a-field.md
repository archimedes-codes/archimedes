---
status: current
last-verified: 2026-11-13
verified-by: code research — 3 researcher angles (desktop blast radius, external PATCH-semantics practice, cross-repo cost of an engine change) run read-only at `17000d0d` on `feature/task-board-selected-space`, plus inline re-verification of every load-bearing claim. Rust: `cargo tree -i fulcrum-harness` and `cargo test -p fulcrum-harness --no-run` were run; **no mutation was compiled**, so every "this would fail to compile / this assertion would not move" claim is a reading of the source, not a measurement — this repo's own mutation standard is unmet here. The external-practice angle returned TRANSMISSION-GARBLED; its two sharpest claims (RFC 7386, GraphQL §2.9.5) were re-fetched and are quoted from the primary source below, and its bug-report citations (Stripe, MCP SDKs) were NOT independently verified and are marked lower-confidence. No test counts are claimed anywhere in this report — tests are named, not counted.
task: tsk_b203ca5b-7496-4018-89d1-3f760237b6e7
---

# `edit_task` cannot clear a field — but the seam it lives in is scheduled for deletion, so the fix belongs on the other side of #183

Research question: *For the `edit_task` patch verb as a whole (`title` / `body` / `spec_path`), which shape makes "clear this field" expressible — a sentinel, a split verb, or a seam change — and what does each cost across the desktop ↔ `fulcrum-harness` boundary?*

Decision context: filed while wiring the `finish` skill to re-point a card at its durable doc on ship
(`docs/roadmap/` is deleted on ship per ADR 0100, and a card left naming a deleted file renders a `spec`
chip that resolves to nothing). Scope was widened from `spec_path` alone to the whole patch verb at the
user's direction, and a `fulcrum-harness` seam change was ruled in-scope to cost, not to assume away.

## Executive Summary

Three findings, and the third changes the recommendation.

1. **The card's premise about the frozen wire pin is refuted.** `the_task_card_view_wire_keys_are_frozen`
   and its TypeScript mirror are **response**-shape pins. Neither constrains `edit_task`'s argument shape,
   so nothing is "forced to move". The pins that actually move are in the engine.
2. **The two callers are not equally repairable.** The human/Tauri path is fixable in one repo. The
   model/harness path is not — the absent-vs-null distinction is destroyed **three times inside the
   published crate** before the desktop sees a value. So the desktop-only fix repairs the half with zero
   production callers, and leaves the half the skills actually use broken.
3. **ADR 0102 deletes this entire subsystem, and it is already in the `approved` lane** (board card #13,
   issue #183, `docs/roadmap/tool-separation.md` `status: approved`). It removes `TaskCall`, `TaskStore`,
   `task_tools.rs` and the `TaskRequest` frame from the crate, replacing them with a vocabulary-free
   `HostToolCall`. Cutting an engine release today buys a wire shape an **accepted** ADR proposes to
   delete; and once #183 lands, the harness path is desktop-owned, which dissolves finding 2 for free.

**So the question is not "which shape", it is "which shape, on which side of #183."** The one layer that
survives either future is `Db::edit_task`'s SQL — that is the invariant fix and it can be made now.

## Findings

### 1. The defect is the whole patch verb; one sibling is invisible, one is out of scope

`Db::edit_task` (`src-tauri/src/storage/db.rs`, the `UPDATE tasks SET …` it executes) patches three
columns through `COALESCE`:

```sql
title = COALESCE(?2, title), body = COALESCE(?3, body), spec_path = COALESCE(?4, spec_path)
```

`COALESCE` makes `NULL` mean "do not change it", so **no value a caller can send sets a column back to
NULL.** Its own doc comment states the rule ("`None` keeps the stored value (COALESCE)"), so this is
documented behaviour — the defect is that the *TypeScript signature advertises three states the SQL
cannot deliver*.

- **`body` has the identical defect** and is the more commonly written field.
- **`title` is not a defect.** The schema declares `title TEXT NOT NULL`, so "clear the title" is not a
  meaningful request. Do not treat the three fields as three instances of one bug.

**Two adjacent defects the card does not cover:**

- `stages.next_slugs` reaches the same *class* of defect by a different mechanism. `Db::set_stage_next`
  is the only statement that writes the column and it always writes JSON, so **NULL is unreachable after
  the migration**. ADR 0099 argues at length what NULL *means* ("unconfigured, unconstrained") and says
  nothing about how to produce it. Same shape of hole — a state the schema admits that no verb can
  reach — reached from the opposite direction, and not in this card's scope.
- The harness path skips `require_title`: the Tauri command cleans a present title, the `TaskCall::EditTask`
  arm does not. Already tracked as board card #15, not a new finding.

### 2. The frozen wire pin does not bind — refuted by reading it, not assumed

| Pin | What it actually asserts | Moves on an argument-shape change? |
|---|---|---|
| `the_task_card_view_wire_keys_are_frozen` (`src-tauri/src/storage/db/tests/mod.rs`) | Serializes a `TaskCardView` and asserts the key sets of `TaskCardView` (4), `TaskRow` (10), `TaskSessionRow` (3) — **responses** | **No** |
| `the task card view wire keys are frozen (mirror of the Rust pin)` (`src/store/tasks.test.ts`) | Reads `TaskCardView` / `TaskRow` / `TaskSessionRow` out of `types.ts`; keys, non-optionality, field types | **No** |
| `task_row_from_maps_the_select_const_columns_in_order` + `EXPECTED_TASK_COLUMNS` | Guards the SELECT projection and the positional mapper | **No** — only a schema change moves it |
| `the_three_task_tables_are_in_schema_and_have_no_gate_entry` | Table names present once, zero `gate("tasks")` | **No** |

The TS mirror's own comment mentions `edit_task` — but only to say the unchanged `TaskRow` is what keeps
`get_task`/`create_task`/`edit_task` "telling the truth", which is a **response** claim.

**What does move, if the harness request shape changes** (all engine-side): the `exec_param_keys()` row
`("edit_task", &["task_id", "title", "body", "spec_path"])`, its enforcer
`tool_specs_advertise_exactly_the_executor_param_keys`, the advertised spec block in `tool_specs.rs`, and
`the_task_store_dtos_serialize_to_the_agreed_camel_case_wire_keys` in `seams.rs`.

**Coverage gap found while checking this:** no test anywhere asserts `specPath: ""` or `body: ""`, and
`src/lib/tauri.test.ts` pins command-name + invoke-argument keys for thirteen other commands but **not**
`editTask` / `createTask` / `getTask` — the task wrappers are only ever `vi.mock`ed. There is also no
direct Rust test of `commands::tasks::edit_task`. **Today's defect is invisible to every automated check
on the desktop side**, which is why it could ship.

### 3. The asymmetry: where the distinction dies on each of the two paths

| Path | Who converts args → the verb | Can "absent" be told from "null"? | Cost |
|---|---|---|---|
| Human → `#[tauri::command] edit_task` | **Desktop** (`src-tauri/src/commands/tasks.rs`) | **Yes**, desktop-only | One repo |
| Model → `edit_task` tool | **Engine** (`fulcrum/src/tools/exec/task_tools.rs`, `opt_str`) | **No** | Engine release + pin bump |

**Tauri path.** The distinction survives the wire and dies in the argument type. `invoke` serialises with
`JSON.stringify`, which drops `undefined`-valued properties and keeps `null` — so `editTask(id)` and
`editTask(id, null, null, null)` send genuinely different bodies. Tauri then collapses both: an absent
key and a present `null` each land as `None` in an `Option<String>` parameter. The raw body is reachable
(`tauri::ipc::Request` → `InvokeBody::Json`), so the desktop *could* separate the states itself — and the
`async` + reference-argument restriction does not bite, because this command already returns `Result`.
Two caveats: a naive `Option<Option<String>>` parameter does **not** recover the distinction (serde maps
`Value::Null` to the *outer* `None`), and there is **no in-repo precedent** for either shape — zero
`Option<Option<…>>` and zero commands taking `tauri::ipc::Request` in `src-tauri/src`.

**Harness path — three independent collapses, all inside the published crate:**

1. `opt_str` maps `None | Some(Value::Null)` to one `None`, and its doc *declares* the intent: it "covers
   BOTH 'absent' and explicit `null` … the seam treats them identically (mirrors `TaskCall`'s
   `#[serde(default)]`)".
2. `TaskCall::EditTask`'s fields are `Option<String>` + `#[serde(default)]` — no room for a third state.
3. The frame **structurally cannot** carry absence: `TaskCall`'s doc states that a `None` optional
   serializes to `null` and decodes from either `null` or an absent key, and
   `the_task_store_dtos_serialize_to_the_agreed_camel_case_wire_keys` pins `"body": null` appearing on the
   wire. So the Worker always spells every unset field as an explicit `null`.

The desktop's first sight of anything is a fully-formed Rust enum in `run_task_call`'s `EditTask` arm.
**No desktop code can recover the information** — it is gone one repo away.

*Is the raw model input observable desktop-side?* Yes — `RpcEvent::tool_execution_start` carries the raw
`args`, and the `SinkFrame`'s `rawInput` carries them again. It is still not a lever: that event is emitted
from the provider stream **before** `run_tool_batch` dispatches, so the desktop sees the args before the
`TaskCall` exists. Acting on them means issuing a second, competing write while the engine's own call still
carries `None` = "leave alone" — and `Db::edit_task` stamps `updated_at` unconditionally, so the extra write
is itself a bug. `store/tasks.ts` already rejects per-card `editTask` calls for exactly this half-succeed
reason.

**The asymmetry is worse than it looks.** `src/store/tasks.ts` states `editTask` is "deliberately ABSENT:
no board action rewrites a card's text", and grepping `src/` for non-test callers returns only the wrapper
definition, the barrel re-export, and two comments. **Zero production callers.** The desktop-only fix
repairs a surface nothing drives; the surface the skills drive (finding 6) stays broken.

### 4. External practice: what the field does, and what it documents as the footgun

| Shape | Primary-source verdict | Documented failure mode |
|---|---|---|
| **`null` = clear, absent = no change** (the three-state reading this signature advertises) | GraphQL spec §2.9.5, quoted verbatim: *"If the value null was provided for an input object field, and the field's type is not a non-null type, an entry in the coerced unordered map is given the value null. In other words, there is a semantic difference between the explicitly provided value null versus having not provided a value."* | Needs a three-state type. GraphQL's own `Maybe!` remedy is **not in the spec** — the tracking issue (graphql-spec #476) is open since 2018 and labelled "Needs Champion", i.e. unaccepted. The pattern lives in libraries (Strawberry, graphql-js `Maybe`, graphql-dotnet `IsSpecified`, elm-graphql's three-constructor `OptionalArgument`), not in the language. |
| **`null` = delete** (JSON Merge Patch) | RFC 7386 §1, verified against the RFC text: merge patch is suitable for documents that *"do not make use of explicit null values"*, and *"The merge patch format is not appropriate for all JSON syntaxes."* | Cannot store a genuine null. (RFC 7386 is itself obsoleted by RFC 7396, same authors, same rule.) |
| **Explicit operation / directive** (RFC 6902 `remove`; k8s `$patch: delete`, `$retainKeys`) | Kubernetes chose a **directive** because old servers *ignore* unrecognised keys but *reject* unrecognised values of a known key — so a new value of `$patch` is unsafe where a new key is safe. | Heavier; a second surface to keep in step with the primary verb. Its own doc now carries a banner steering readers to Server-Side Apply. |
| **Field mask** (`google.protobuf.FieldMask`, AIP-134/161/149/203) | Google's answer to "which fields did the caller actually send". Protobuf's own design notes describe implicit presence as a decision the team **regrets**, because a zero in a patch is indistinguishable from an omission. | Moves presence out of the message; wrapper types are not wire-compatible, so the fix cannot be reversed. |
| **Sentinel `""` = clear** | Appears mainly where the transport cannot carry null or absence at all. | **Stripe's** documented footgun: an empty string is a legitimate value for some parameters, and the API answers with a registered `parameter_invalid_empty` error code. *Lower confidence — read out of the garbled angle, not independently re-verified.* |
| **MCP / LLM tool arguments** | **No guidance exists.** The MCP spec is silent on clearing an optional tool argument; the nearest is Anthropic's general "avoid ambiguity" advice in *writing tools for agents*. | This absence is itself a finding: **an LLM tool has no standard here**, so nothing external settles the choice. |

**Applying the repo's own discriminator** — *"which reading would a caller guess wrong about"* (AGENTS.md,
poisoned-mutex bullet's framing) — a caller reading `specPath?: string | null` guesses **`null` clears it**.
GraphQL's spec says that guess is the semantically correct one. The signature advertises three states and
delivers two; that is the defect, stated precisely.

### 5. `""` is not a cheap option — it is a live UI bug, and it fails differently per surface

Both render sites gate on `!== null`, so an empty string reads as a **present** value:

- `src/components/TaskCard.tsx` — `{task.specPath !== null && (<span …>spec</span>)}`. The chip renders the
  literal word `spec` and deliberately never the path, so **`""` produces a chip pixel-identical to a real
  one.** This is the worst available outcome: the sentinel is indistinguishable from a genuine pointer.
- `src/components/TaskDetailDialog.tsx` — also gates on `!== null`, so a `spec` meta row with an empty value.
- `body` **fails differently per surface**: `TaskCard.tsx` gates on `task.body &&` (so `""` is hidden,
  indistinguishable from NULL) while `TaskDetailDialog.tsx` gates on `!== null` (so `""` renders an empty
  paragraph). One sentinel, three outcomes.

`spec_path` is not in `src/lib/taskPrompt.ts`'s launch block (which reads `id`, `stageSlug`, `title`, `body`,
`artifactKeys`), so the `""` hazard is confined to those two surfaces — but no test covers either.
`update-task-with-findings/SKILL.md` already warns that `""` writes an empty string, not NULL.

### 6. The callers that actually need a clear are the skills, not the UI

Zero app-code callers (finding 3). The real consumers document the limitation as a constraint they work
around:

- `finish/SKILL.md`: re-pointing the card is *"the only move available and it is the right one: `edit_task`
  **cannot** null a `spec_path` out … which means a card whose spec file was deleted would keep pointing at
  it forever unless you re-point it at something that exists."*
- `update-task-with-findings/SKILL.md`: `spec_path` *"can be **replaced but never cleared** … the only repair
  is a better path"*, plus the standing rule that pointing `spec_path` at a gitignored file is *"worse than
  leaving it null"* — which is the exact state `finish` creates on ship.

So the two skills currently carry the defect as **prose**, and one of their workarounds (re-point at a
durable doc) is unavailable in the case the card names: nothing was folded into `docs/features/`.

### 7. In-repo precedent is lopsided, and points away from a sentinel

| Shape | Count | Notes |
|---|---|---|
| Dedicated setter verb that **can** clear | **2** | `Db::set_stage_skill` (`None` → NULL, plain assignment, pinned by `set_stage_skill_sets_and_clears_the_skill` with the message "`None` clears the column rather than writing an empty string") and `Db::record_session_todos` (pinned by `record_session_todos_roundtrips_and_clears`) |
| COALESCE patch verb that **cannot** clear | **1** | `Db::edit_task`, and it is the only COALESCE patch in the file — the other `COALESCE` uses are aggregation floors and a pagination sentinel |

**`record_session_todos` is the closest precedent to a fix**: the same `Option<&str>` parameter type as
`edit_task`, and it *can* clear — the only difference is that it assigns instead of COALESCEing. The
harness path can therefore already clear `todos_json` through a seam with the identical signature, which
tells us the constraint is the SQL, not the type.

`Db::delete_stage`'s `relocate_to: Option<&str>` is the instructive counter-example: it faces the same
"what does `None` mean" ambiguity and resolves it by **refusing** (`StageNotEmpty`) rather than by silence.
`Db::set_stage_next` refuses to collapse `[]` and NULL at all, and ADR 0099 calls collapsing them *"the
silent-green shape"* it rejects — the repo's own stated aversion to exactly the shape `edit_task` shipped.

### 8. The decisive cost finding: ADR 0102 deletes this subsystem and is next in line

`docs/decisions/0102-*.md` — `status: accepted`, 2026-11-11 — *"the crate forgets Tasks exist"*. It deletes
from `fulcrum-harness`: `task_tools.rs` (1,191 lines), `worker/task_store.rs` (567), `TaskStore` /
`TaskCaller` / `TaskCall` / `TaskStoreError` + the five board DTOs, `ToolCtx.task_store` — **the field that
forced the 0.2.0 bump** — and the `TaskRequest` / `TaskResponse` frame pair, replaced by a generic
`HostToolCall` / `HostToolResponse` carrying **no tool vocabulary**. `tool_specs()` goes 26 → 19 while the
model is still advertised the same 26 names (a 26-name invariance census is written before anything is
deleted).

Plan: `docs/roadmap/tool-separation.md`, `status: approved`, `issue: …/issues/183`, three-commit migration.
Board card **#13 "Tool seperation"** (artifacts: `spec`, `adr-0102`) sits in the **`approved`** lane, ahead of
this card's `research` stage. Verified: the engine work has **not started** (`host_tools` / `HostToolCall` →
zero hits in `fulcrum/src/`), so the `TaskCall` shape discussed here is the shape 0102 targets.

**Cost of the engine path today** (three repos' worth of ceremony):

1. Engine work + its gates (`cargo test` ~1406, clippy `-D warnings`, fmt, the mingw `cargo check`, the
   allocator / schema-drift / stray-process / version scripts). **`check-schema-drift.sh`'s cross-repo half
   does not run — the desktop has no comparator step**, so a `TaskCall` change gets no cross-repo automated
   check at all.
2. Version bump in **three** files (root `Cargo.toml`, member `Cargo.toml`, `Cargo.lock`), guarded only by
   `check-versions.sh` printing `versions match: X.Y.Z`.
3. Annotated tag; `release.yml` makes a GitHub release and **does not publish to crates.io**.
4. **`cargo publish -p fulcrum-harness` by hand** — bare `cargo publish` refuses (the daemon is
   `publish = false`).
5. Desktop pin bump + `cargo update -p fulcrum-harness` + the `router.rs` arm **in the same commit** (the
   engine's own rule: an exhaustive `match` must gain its arm in "the SAME commit that bumps the crate pin",
   enforced desktop-side by `d2_ships_the_artifacts_block_and_the_verbs_that_answer_it_together`). Then the
   full desktop gate: `pnpm test`, `pnpm build`, `cargo test`, `cargo clippy --all-targets` (0 warnings), fmt.

Two aggravating facts: **`seams.rs`'s key-set pin — the one test that would catch a mis-shaped `EditTask` —
never runs in desktop CI** (the crate is not a workspace member, so its ~1400 tests run only in the engine's
CI), and `fulcrum-harness = "0.2.0"` means `^0.2.0`, so a future `0.2.x` is adoptable by a lockfile touch
alone. Release cadence gives no cover: **two publishes exist** (0.1.0, 0.2.0), both minors, both driven by a
breaking change, both within days of the crate becoming publishable — there is **no precedent here for
shipping a small seam widening as a `0.2.x`**.

**Additive vs breaking, per candidate** (readings of the source, not compiled — see Gaps):

| Candidate | Wire | Source | Desktop compile | Silent failure |
|---|---|---|---|---|
| New `TaskCall` variant (e.g. `ClearTaskField`) | additive | breaking | **loud** — non-exhaustive `match` in `router.rs` and in the engine's `verb_of` | A new *verb* in a known frame is a hard decode error (no `serde(other)` anywhere), the frame is dropped, the parked oneshot never resolves → **hang until turn cancel**. Latent while Worker and Supervisor are one binary; live the moment a daemon client (T12) exists. |
| New optional key on `EditTask` (e.g. `clear: Vec<String>`) | additive | breaking | loud (`E0027`/`E0063`) **only if the destructuring has no `..`** | **`..` satisfies the compiler**, the key is silently discarded, and the tool still reports `"edited"` — a green build that blanks nothing. Neither repo asserts the desktop's arm *reads* every field. |
| Make `opt_str` separate null from absent | breaking | breaking | loud, but everywhere | Not separable: `Option<&str>` has two states and the requirement is three, so the type must widen; and `Db::edit_task`'s `COALESCE` **is** the collapse in SQL, so no engine change blanks anything on its own. |

Note the framing that makes the wire-skew worry moot and the source-coordination worry real: **the Worker is
a `current_exe()` self-exec of the same binary**, so Supervisor and Worker are always one build and no wire
skew between them is representable (ADR 0102 states this for the same reason). The exposure is source
compatibility at the pin, plus a `0.2.x` re-resolve carrying a semantic change the desktop suite cannot see.

**And after #183, the asymmetry in finding 3 disappears**: the desktop would own `edit_task`'s spec *and*
executor, so a three-state signature becomes a one-repo change for **both** callers. `Db::edit_task`'s SQL is
the only layer that survives either future.

## Evidence

**Local (high credibility — read at `17000d0d`; locate by symbol, paths may move).**
`src-tauri/src/storage/db.rs` (`Db::edit_task`, `set_stage_skill`,
`set_stage_next`, `record_session_todos`, `delete_stage`, the `tasks` schema, `TASK_COLUMNS`);
`src-tauri/src/commands/tasks.rs` (`edit_task`, `require_title`);
`src-tauri/src/agent/session/router.rs` (`run_task_call`'s `EditTask` arm; the `Event` arm's bookkeeping-only
comment); `src/lib/tauri/commands/tasks.ts`; `src/lib/tauri/types.ts`; `src/store/tasks.ts`;
`src/store/tasks.test.ts`; `src/lib/tauri.test.ts`; `src/components/TaskCard.tsx`;
`src/components/TaskDetailDialog.tsx`; `src/lib/taskPrompt.ts`; `src-tauri/src/lib.rs` (the `current_exe()`
worker factory); `docs/decisions/0090`, `0092`, `0099`, `0100`, `0102`; `docs/roadmap/tool-separation.md`;
`src-tauri/Cargo.toml`'s pin comment; `.cargo/config.toml.example`; `AGENTS.md`.
Engine at `7f21099` (= tag `v0.2.0`): `src/seams.rs`, `src/tools/exec/task_tools.rs`,
`src/harness/tool_specs.rs`, `src/worker/{protocol,client,task_store}.rs`, `src/harness/loop/turn.rs`,
`AGENTS.md`. Verified the sibling checkout is **byte-identical to the published 0.2.0** for the files that
matter (matching md5s, and the crates.io checksum equals the `Cargo.lock` entry), and that the
`[patch.crates-io]` override is **not live** here — `cargo tree -i fulcrum-harness` prints a bare
`fulcrum-harness v0.2.0` with no path suffix, and `Cargo.lock` holds no `[[patch.unused]]`.

**External — independently re-verified (high credibility):** RFC 7386 §1 via rfc-editor.org; GraphQL
spec §2.9.5 / input-object coercion via spec.graphql.org.

**External — NOT independently verified (medium/low credibility, read out of a garbled angle):** RFC 6902
and the erosb commentary; Kubernetes `strategic-merge-patch.md` and the `$retainKeys` design proposal;
protobuf `field_mask.proto`, the implicit-presence design note, AIP-134/149/161/203; the GraphQL-spec #476
issue and the library `Maybe` conventions; Stripe `parameter_invalid_empty` and the Stripe client-library
reports; the MCP spec's silence and the Anthropic/OpenAI tool-use guidance; the MCP C#/TypeScript SDK and
`mupot`/`scrap`/`nimblebrain` reports. Each is a real-looking citation; **treat the shapes as supported and
the specific bug reports as unconfirmed.** The direction they point is unanimous and agrees with the two
sources I did verify: no mainstream design collapses absent and null *and* offers no way to clear.

## Unresolved Contradictions

None between the three angles. One **provenance** conflict worth recording rather than smoothing over: the
external-practice angle's output was **transmission-garbled** — interleaved fragments, broken URLs,
truncated quotes. Its two load-bearing claims were re-fetched from primary sources and both confirmed
verbatim (quoted in finding 4). Everything else from that angle is carried at reduced confidence and
labelled as such above. Had it been taken at face value, several of its citations would have been
unverifiable in the report.

## Gaps

- **No mutation was compiled.** "Adding a variant moves no existing assertion", "adding a field yields
  `E0027`/`E0063` at these sites", and the additive/breaking table are readings of the source. This repo's
  own standard — *a mutation that still compiles and changes what something returns* — is unmet, and a
  read-only pass cannot meet it. The sharpest untested claim is whether `the_task_store_dtos_serialize…`
  really does not census the number of `TaskCall` variants.
- **The "unknown verb → dropped frame → hang-until-cancel" chain is assembled from four files, not
  executed.** `seams.rs` has no `serde(other)` and `decode_outbound` re-decodes the whole frame, so the
  inference is direct — but nobody has run an old-supervisor / new-verb pair. Latent today, live under T12.
- **`docs/roadmap/tool-separation.md` states no timeline.** "Next in line" is inferred from `status:
  approved` + the `approved` board lane + ADR `status: accepted`, not from a schedule. Its §3 three-commit
  migration order — specifically where `edit_task`'s spec lands once the desktop owns it — was **not** read
  in full, and it is the one document that would firm up the recommendation.
- **Whether `""` reaching `spec_path` has any consumer beyond the two render sites** was checked only as far
  as `taskPrompt.ts`.
- **`stages.next_slugs`'s unreachable NULL** (finding 1) is flagged, not investigated.
- **No release-cadence trend exists** to lean on — two publishes, five days apart, no CHANGELOG, repo ~7
  weeks old. "Is cutting a crate release routine?" is genuinely unanswerable from this evidence.

## Where this points (not a decision — for `specify` to take or refuse)

The findings separate cleanly into a **now** half and a **after #183** half:

- **Now, desktop-only, no crate release:** make `Db::edit_task`'s SQL able to clear (the layer that survives
  either future); give the Tauri command a real three-state argument; guard the two render sites so `""`
  cannot masquerade as a pointer; add the missing `""` tests and the missing `editTask` invoke-argument pin.
- **Do not cut an engine release for this** while ADR 0102 stands accepted and approved — it deletes the
  `TaskCall` shape such a release would freeze, and after it the harness path is desktop-owned.
- **Fold the harness-side decision into #183**, where it costs nothing extra, and say so on this card rather
  than leaving it as a silent backlog item.
- The ADR check applies to the *"we deliberately did not widen the seam because 0102 deletes it"* decision —
  it is surprising without context, a real trade-off, and expensive to rediscover. `specify` should decide
  whether it becomes an ADR or a consequence appended to 0102's family.

## Follow-up

The **now** half shipped on `feature/edit-task-clear-fields`; the **after #183** half did not, and the
decision to leave it is recorded in **ADR 0102's Consequences** — the option this report left to `specify`
landed as a consequence on the existing ADR rather than as a new file.

What landed, against the list above:

- `Db::edit_task` takes a three-state `FieldPatch` (`Keep` / `Set` / `Clear`) and drives one fixed-arity
  `CASE` UPDATE whose mode is a bound parameter, not a formatted one. The `COALESCE` statement is gone.
- The Tauri command reads presence off the raw invoke body, so it does take `tauri::ipc::Request` as
  finding 3 predicted — the first command in the repo to. An absent key keeps, an explicit `null` clears,
  a string writes, and any other JSON type is refused by name and type. `title` refuses `Clear` for the
  reason finding 1 gives (`tasks.title` is `NOT NULL`). One deviation from the plan's sketch: the command
  wraps its spawn in `wire_call`, not `board_call`, because its body now composes command-layer refusals
  with a storage call and `board_call` is typed to a `BoardError` with no honest arm for a wire refusal.
- Both render sites treat `""` as no pointer and no body, so finding 5's pixel-identical chip is closed.
  `""` remains a `Set` on the write side — the two questions stay separate.
- The TS wrapper's signature is **unchanged** (its doc comment is not); what it advertised is now what the
  backend delivers. The missing `editTask` invoke-argument pin named in finding 2's coverage gap now exists
  in `src/lib/tauri.test.ts`, along with `""` coverage on both render sites.

What did not: `impl TaskStore for Db` maps `Option<&str>` with `None` → `Keep`, so `TaskStore::edit_task` /
`TaskCall::EditTask` remain two-state and **a model's `edit_task` still clears nothing.** No crate release was
cut. ADR 0102's Consequences carries the reasoning, names **#183** as the point where the third state becomes
reachable from the tool, and states the falsifier — abandon #183 and the harness-side clear becomes real work
again rather than waived work. `impl TaskStore for Db`'s own body comment points at the same place, so the
deferral is discoverable from the code and not only from here.

