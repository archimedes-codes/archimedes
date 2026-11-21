---
status: accepted
date: 2026-11-20
superseded-by:
---

# The Stage wire type is renamed to `StageDto` on the TypeScript side only, so the component can own `StageRow`

`src/components/StageEditor.tsx` (504 production code lines) was declined in PR #206 as *"needs a
3-deep split to be honest — a redesign, deferred"*, and the census's honest shape named the row child
**`StageRow`** (`docs/research/production-godfile-census-and-the-size-metric.md`, §F4 — the paragraph
that opens *"Ruled against, with the reason:"*, cited by content rather than line number because that
file grows and a line citation here would orphan on the next census edit). That name is
already taken: `export interface StageRow` is the TypeScript mirror of `pub struct StageRow`
(`src-tauri/src/storage/db.rs:553`), named in 14 TS files at `main`: 9 import it and 1
(`src/lib/tauri.ts`) re-exports it, `src/lib/tauri/types.ts` DECLARES it, and the last 3 hold it only as
a string literal or in comments (see Consequences). Naming the component `StageRow`
compiles — types and values are separate namespaces — but it puts
`function StageRow({ stage }: { stage: StageRow })` in one file, and `AgentRow` dodged that collision
only by luck: its DTO is `AgentDefinitionReportDto`, a *payload*, not a storage row.

We decided to **rename the TypeScript type to `StageDto` and leave the Rust struct named `StageRow`**,
giving the component the freed name. The mirror is therefore **deliberately asymmetric for this one
type**: TS `StageDto` ↔ Rust `StageRow`.

## The mirror rule, and exactly which half is given up

`src/lib/tauri/types.ts`'s header states the file is *"the TypeScript mirror of the Rust IPC surface"*,
and the mirror holds **two families**, which is why "just match the `Dto` convention" is not the whole
answer:

| Family | TS | Rust | Naming |
|---|---|---|---|
| command payloads | `ModelDto`, `ListingDto`, `AgentDefinitionReportDto` | `pub struct ModelDto` (`commands/settings.rs:108`), `pub struct ListingDto` (`commands/files/space_walk.rs:21`) | suffixed **on both sides** |
| storage rows | `TaskRow`, `SpaceRow`, `TaskSessionRow`, `StageRow` | `pub struct TaskRow`, `pub struct SpaceRow`, `pub struct TaskSessionRow` — all `storage/db.rs` | **unsuffixed on both sides** |

`StageRow` is correctly named today: a row of the `stages` table, in the unsuffixed family with four
siblings in the same file. **This decision knowingly breaks that family's rule for one member.** What
survives is the load-bearing half — field names and their camelCase, which is what actually crosses the
wire — and what is given up is name-for-name traceability at the type level. A reader who greps
`StageDto` in `src-tauri/` finds nothing and must be told, by the comment at the declaration, to grep
`StageRow` on the Rust side.

## Why the Rust struct keeps its name

- **The type name never crosses the wire, so the desync has no functional cost.** `"StageRow"` appears
  in **zero** Rust string literals, and every board type carries `#[serde(rename_all = "camelCase")]`,
  which renames *fields* only. And there is **no bindings generator** — no `ts-rs`, no `#[derive(TS)]`,
  no `gen_ts`, no `spectypes` anywhere in `src-tauri/` — so `types.ts` is hand-written and nothing
  regenerates from the Rust name. The rename is source-level on both sides of the seam; renaming Rust
  would buy a symmetry nothing consumes.
- **Renaming it would collide with an approved plan that owns that file.**
  `docs/roadmap/db-split-and-mirror-test-tree.md` (`status: committed`) opens with
  `git mv src-tauri/src/storage/db.rs src-tauri/src/storage/db/mod.rs` and splits the file into 8
  subject siblings; `pub struct StageRow`, `stage_row_from`, `STAGE_COLUMNS` and `StageWithTasks` all
  live in it. Editing that file from a second branch to change a name with zero functional effect is a
  coordination cost paid for nothing.
- **It keeps a durable doc true instead of making it wrong.**
  `docs/features/task-board-known-gaps.md` §3 cites `StageRow` as a **storage** fact, at `:186-187`:
  *"`STAGE_COLUMNS` is 7 entries, `StageRow` carries `on_enter_skill`, `set_stage_skill` writes it"*
  (quoted across the file's line break, which falls inside the clause). Renaming Rust reddens that
  sentence — it names the type as a row of the `stages` table read by `set_stage_skill`; renaming TS
  only leaves it accurate. The census citation in the first paragraph is about the **component**, and
  becomes accurate.
- **The Rust name is the accurate one.** It *is* a row of the `stages` table, and `db.rs` is 2,154 code
  lines with its own approved split — the asymmetry is the price of not reopening it.

## Considered Options

- **Name the component something else — `StageForm`, `StageEditorRow`.** Rejected: cheapest, and the
  only option that leaves the mirror intact, but it permanently spends the natural name on the DTO.
  The *row* is what the editor renders and what the glossary calls a Stage
  (`CONTEXT.md:349` sanctions "row" and explicitly `_Avoid_: column`); the wire shape is the borrower.
- **Take `StageRow` for both, in separate namespaces.** Rejected: free today, but it leaves one file
  answering one noun with two referents a screen apart, which is the ambiguity a rename exists to
  prevent.
- **Rename both packages.** Rejected: it edits the file the db-split plan owns, for symmetry no
  generated binding consumes, and it makes a durable storage doc wrong.
- **Rename the whole TS `*Row` family to `*Dto`.** Rejected: 5 types, ~4× the surface, and it would
  *create* a new inconsistency by renaming four correctly-named mirrors to free one.

## Consequences

- **`StageWithTasks` keeps its name** and its field becomes `stage: StageDto`, while the Rust
  counterpart stays `pub stage: StageRow`. The divergence is visible there too, so the comment belongs
  on `StageDto` and must be read alongside it.
- **TWO TypeScript pins hold the name as a string literal**, and an identifier-only rename misses both:
  `src/lib/tauriBarrel.test.ts:439` (`"StageRow"` in `TAURI_PUBLIC_API`, compared as a SET with
  `expect(surface).toEqual([...TAURI_PUBLIC_API].sort())` at `:797`) and `src/store/tasks.test.ts:1467`
  (`interfaceFields(types, "StageWithTasks")` field *types* asserted `toEqual(["StageRow",
  "TaskCardView[]"])`, which parses `types.ts` as text). Set equality means a stale entry and a missing
  entry both redden, so neither edit can be split away from the rename.
- **The rename is 60 LINES / 64 OCCURRENCES of `StageRow` across 14 TS files at `main`** — the two
  units differ because four lines carry the name twice (`git grep -c StageRow main -- src | awk -F:
  '{s+=$NF} END {print s}'` → 60 lines; `git grep -o StageRow main -- src | wc -l` → 64 occurrences).
  Of the 14 files, **2** mention it only inside comments — `src/lib/taskPrompt.ts` (2 lines, both `*`
  comment) and `src/store/taskLaunch.test.ts` (1 line, same) — and the other 12 carry at least one
  non-comment occurrence the rename is forced to touch (the line anchors below are `main`'s, before the
  rename). Three of the files a loose reading
  would call "prose" are not: `src/lib/tauri.ts` re-exports the type (`StageRow,` at `:154`),
  `src/lib/tauriBarrel.test.ts` holds it in the `TAURI_PUBLIC_API` string array (`:439`), and
  `TaskDetailDialog.test.tsx` imports it (`type StageRow,` at `:27`) and uses it in a `Pick<…>` type
  at `:130`. Comment-only mentions do not break; they go stale, and the ones that name the type as
  *the wire type* should be updated in the same commit.
- **`docs/research/production-godfile-census-and-the-size-metric.md` and
  `docs/features/godfile-decomposition-closeout.md` both cite `StageRow`** as a constraint on the
  `tasks.rs` and `StageEditor` splits. A reader arriving from them needs this ADR to resolve the name.
- **This is not a new rule and must not be read as one.** It does not license renaming the other four
  TS `*Row` mirrors. The rule is still "mirror the Rust name"; this is a recorded exception with a
  specific reason, and the next such request needs its own argument, not a citation of this one.
