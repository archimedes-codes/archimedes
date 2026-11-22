---
status: accepted
date: 2026-11-17
superseded-by:
---

# A split production unit gets a MIRROR test tree: one `tests/` child per production child, by subject

`AGENTS.md` already prescribes the *shape* — `mod tests;` plus a `tests/` directory, never a
`tests.rs` sibling (`find src-tauri/src -name 'tests.rs'` reports **0** sites) — and
`docs/agents/test-counts-and-splits.md` prescribes splitting that region **by subject**. Neither says
what the children are *named*. Splitting `src-tauri/src/storage/db.rs` made that gap consequential:
its test region is a single flat 6,128-code-line module with zero inner `mod` declarations, and **ten**
production subjects land beside it. (The plan approved nine; implementation added a tenth,
`db/migrations.rs` — see the Consequences, which record why that is a consequence of this rule rather
than drift from the plan.)

We decided the test tree **mirrors the source tree**: when a production unit is split into
`foo/mod.rs` + `foo/<subject>.rs`, its `foo/tests/` holds one child per production child with the
**same name**, `foo/tests/mod.rs` stays a shell of `mod` declarations, and `foo/tests/support.rs` is
the only non-mirror child — the home for fixtures several subjects share. Where production is **one**
file, the test children are named by subject and there is nothing to mirror file-for-file; that is
already the shape of `commands/tasks.rs` (one 540-code-line file) with
`commands/tasks/tests/{board,stages,artifacts,seed}.rs`.

## The parent is `mod.rs`, and this reverses a recorded recommendation

`docs/research/production-godfile-census-and-the-size-metric.md` recommended that `db.rs` **keep its
name as a plain file**, and probed the reason: `include_str!("../m.rs")` fails to compile once `m.rs`
becomes `m/mod.rs`. That recommendation is **reversed here for the production parent**, for a
convention reason the report did not weigh — the report's own claim that *"`foo/` directories that use
`mod.rs` are test-only"* is **false**: `src-tauri/src/commands/files/mod.rs` is 92 code lines of real
production, and **both** multi-file production units in this repo (`commands/files/`,
`agent/session/`) use `mod.rs` as the parent. There is no in-repo precedent for `foo.rs` with
production siblings.

The reversal is priced, not assumed. Six tests read a source file's text by path and all six fail
**loudly** — `error: couldn't read src/m/tests/../../m.rs: No such file or directory`, reproduced with
a throwaway crate — so none can go silently green:

| Site | Reads | Re-points to |
|---|---|---|
| `db/tests/mod.rs` (gate-count, DDL-FK, board-projection, backfill) | `include_str!("../../db.rs")` ×4 | `../mod.rs`, `../board.rs` |
| `commands/tasks/tests/stages.rs` | `include_str!("../../../storage/db.rs")` | `../stages.rs` |
| `commands/tasks/tests/artifacts.rs` | `format!("{manifest}/src/storage/db.rs")` | `seams.rs` |

⚠ The last one is the only pin that does **not** fail at compile time: it builds its path from
`CARGO_MANIFEST_DIR` as a **string**, so a stale path panics at *runtime*. And the gate-count pin
asserts `source.matches("gate(&mut conn, ").count() == 12` with all 12 gates inside `pub fn open` —
which is what forces `open` (and `SCHEMA`, and the migration free functions) to stay **whole** in
`db/mod.rs`. Those pins are a constraint on the split, not collateral damage from it.

## Why the mirror costs almost nothing, measured

The predecessor report named the test module's `use super::*` glob as the dominant hidden cost of any
split. Probed against this repo's edition and toolchain, that cost **does not exist for a test child**:

- A test **grandchild** doing `use crate::db::*;` reads the ancestor's **private** `SCHEMA` const and
  private `gate` fn — compiles, and `cargo clippy --all-targets -- -D warnings` exits 0. So each new
  test child opens with one glob and gets everything today's `use super::*;` supplies; the ~24
  ancestor-private names the region references (`gate` ×93, `SCHEMA` ×18, the `*_row_from` mappers,
  the `*_COLUMNS` consts) cost nothing to re-home.
- A **sibling** production file may read the parent's private `const`/`fn` by full path.
- A sibling may **not** read a sibling's private item — `error[E0603]: function is private` — so the
  shared row mappers and stage helpers need `pub(super)`. **27** `pub(super)` tokens — declarations,
  not mentions: `rows` 18, `stages` 5, `migrations` 3, `seams` 1 — and it fails loudly. Count them with
  the comment-anchored filter `grep -rn 'pub(super)' src-tauri/src/storage/db/*.rs | grep -vc '://'`,
  never the raw grep: that prints **32** because five comment lines (one in `stages.rs`, four in
  `db/mod.rs`) discuss the token itself — the trap `docs/agents/census.md` exists to catch. Both
  32 and 27 are LINE counts, which is what `grep -rn` emits and what the filter subtracts, so do
  not re-derive them by counting the token instead: it occurs 33 times across those files, because
  one of the five comment lines (`db/mod.rs:26`) quotes it twice. 27 is also the figure
  `db/mod.rs` carries in its own split block, so doc and code agree.
- Relocating a `#[cfg(test)] mod tests` out of a file creates **no** dead-code lint. A private item
  whose only reader is the test module fails `-D warnings` **identically inline and relocated**
  (dead-code analysis runs per compilation target, so a `cfg(test)` reader never counts in the
  non-test build). Relocation additionally *removes* clippy's `items after a test module` lint.

## Considered Options

- **Keep `db.rs` as a plain file with production siblings.** Rejected: unique in the tree, and the
  only reason on record for it was the `include_str!` cost, which is six one-line edits that all fail
  loudly.
- **Mirror by subject only, not by filename.** Rejected: it leaves a reader mapping
  `db/tests/board.rs` to a production file by reading both, which is the navigation cost the mirror
  exists to remove. `commands/files/` already proves the file-for-file form is free.
- **Split the test region without splitting production.** Rejected as a repeat of a recorded failure:
  `936dcafe` moved `mod session_tests` into the correct directory shape and the flat module survived
  the move — `docs/agents/test-counts-and-splits.md` calls it *"a completed move, not a completed
  split."*

## Scope: what the rule does NOT demand

The mirror binds **a `tests/` directory that exists**, and it requires extraction only where a region
already crosses a trigger — ADR 0112's 1,000-code-line test gate, or `AGENTS.md`'s subject-count rule.
It does **not** demand that every production child in the tree get an extracted test child. That
narrowing is deliberate: `src-tauri/src/commands/` holds **14** production children and only **11** of
them carry an inline `mod tests` at all (`key_focus.rs` and `skills.rs` hold no test region;
`tasks.rs` has its tests **extracted** into `commands/tasks/tests/`). The other multi-child units are
thinner still — `agent/` 2 inline of 3 children, `agent/harness/` 1 of 2, `attention/delivery/` **0 of
2**, neither carrying a test region of any kind — and a rule read as mandating ~14 new test directories
is a rule that gets ignored rather than followed.

## Consequences

- **Adopting the rule creates named violations, and this branch has fixed one of the two.** Measured
  against every unit with more than one production child, `commands/files/` satisfied the mirror at
  the time this ADR was written (production children `completion`, `image`, `space_walk`, `token`;
  test children the same four, plus `support.rs`). Two units did not: `storage/db/tests/` and
  `agent/session/tests/`.
  **`storage/db/tests/` is now compliant** — child-for-child, measured at this branch: production
  children `artifacts`, `board`, `messages`, `migrations`, `rows`, `seams`, `sessions`, `spaces`,
  `stages`, `tasks` beside test children of the same names, plus `open.rs` mirroring the `mod.rs`
  parent that keeps `Db::open`, `gate` and `SCHEMA`, plus `support.rs` as the **only** non-mirror
  child, plus a `tests/mod.rs` that is nothing but `mod` declarations (12 code lines at the split
  commit `8ef9d14d`). `seams.rs` was the last gap and it is **closed, not exempted**: it now has
  `db/tests/seams.rs` holding the unit-level seam tests — trait-bound instantiations of both
  `FulcrumPersistence` and `TaskStore` on `Db`, plus direct `desktop_row_to_crate_row` field-mapping
  assertions. It was never an instance of the "pure data table" permission below, and this ADR used to
  cite it as one: that citation is **withdrawn**. `db/seams.rs` is 221 code lines, 25 functions of
  which 23 are trait methods, and **zero** SQL — a delegation surface is the opposite of a data table,
  and its shape is exactly what a test child exists to pin.
  **`agent/session/tests/` remains a violation**: one flat `mod.rs`, 3,178 code lines, zero inner
  `mod` declarations, against production children `naming.rs`, `router.rs` and `naming/prompt.rs`. It
  has its own card and is not this branch's to close.
- **The split landed TEN production subjects, not the nine this ADR was written against, and the
  tenth is a consequence of this rule.** The plan held that the migration free functions had to stay
  in `db/mod.rs`; that constraint was **false** — all 12 `gate(&mut conn, ` calls are inside `pub fn
  open`, which is what the gate-count pin reads, so the free functions were never pinned to the parent
  and were free to move. Without a `db/migrations.rs` sibling the mirror has nowhere to put the
  migration tests, and they would land in the parent-mirroring child: `db/tests/open.rs`'s 735 code
  lines plus `db/tests/migrations.rs`'s 490 is **1,225** code lines (1,645 raw) — over the very gate
  this PR introduces. The
  mirror is what forced the tenth subject: a test child needs a
  same-named production child, so the subject that could not be named in the test tree had to be named
  in the production tree.
- **`storage/batching.rs` is NOT a mirror violation** and must not be cited as one. It is one
  production file with one `tests/mod.rs`, so the mirror is trivially satisfied; its 1,079 test code
  lines are a *subject-count* problem under the existing rule and, above ADR 0112's gate, a governed
  size. Both are real and neither is about mirroring.
- **The mirror binds the *naming*, not the count.** A production child may legitimately have no test
  child — the case this is written for is a **pure data table**, a child whose only content is a table
  of values no test can meaningfully assert over — and a test child may exist for a subject the parent
  holds inline, so `support.rs` and a subject that lives in `mod.rs` are both expected. **This
  permission has no instance in `storage/db/` and must not be cited for one.** It used to be cited for
  `seams.rs`; that citation was wrong (see the Consequences bullet above) and is withdrawn. A child
  that delegates, maps or transforms is not a data table, and before this bullet is used to excuse a
  missing test child, read the child: `db/seams.rs` is the worked example of one that looks small and
  is 23 trait methods deep.
- **A mirror child is a governed file** under ADR 0112's test class, so the split is self-defending:
  a `db/tests/<subject>.rs` creeping back toward 1,000 code lines reddens the ratchet.
- **`docs/agents/test-counts-and-splits.md`'s "the shape that works" paragraph should be read with
  this ADR**, which supplies the naming rule it omits.
