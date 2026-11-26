//! The `db` test tree — ADR 0113's MIRROR of the production split: one child per
//! production sibling, same names, and [`support`] as the only fixture child that
//! mirrors nothing.
//!
//! `mod.rs` above (`db/mod.rs`) keeps `Db::open`, `gate`, `SCHEMA` and
//! `LAST_ACTIVITY`, so [`open`] is the child that mirrors the parent; every other
//! child has a production sibling of the same name. `support` holds the fixtures
//! several subjects share — the raw-SQL probes and the legacy-schema fixtures.
//!
//! ONE PRODUCTION SIBLING HAS NO SAME-NAMED TEST CHILD, and it is ADR 0113's own
//! named case rather than a gap: `db/stages.rs` is mirrored by a PAIR,
//! [`stage_lifecycle`] and [`stage_setters`]. So a reader who diffs the two
//! directories' name-sets should expect exactly one unmatched production name
//! (`stages`) and two unmatched test names — plus `open`, which mirrors the
//! `mod.rs` parent and is the documented shape above, not a deviation.
//!
//! `db/stages.rs` is ONE production file, and ADR 0113 governs exactly that case —
//! "Where production is **one** file, the test children are named by subject and
//! there is nothing to mirror file-for-file", with `commands/tasks/tests/` (one
//! production file, four subject-named children) as the precedent. The split was
//! forced by ADR 0112's 1,000-code-line test gate: `db/tests/stages.rs` measured
//! 985 with 24 tests, so a 25th test anywhere in it reddened CI. The subject
//! boundary is the column's EXISTENCE and POSITION (the seed, the migration,
//! `create`/`rename`/`reorder`/`delete`) against the per-column VALUES (the five
//! `set_stage_*` verbs); both children's headers state it, name the two tests that
//! straddle it and where they landed, and carry the poisoned-mutex rationale for
//! the sites they hold or do not hold.

// ONE TEST CHILD CARRIES A TEST NAMED FOR ANOTHER SUBJECT'S PAYLOAD, and it is a
// placement correction rather than a new exception to the mirror rule:
// `the_task_card_view_wire_keys_are_frozen` used to live in [`board`]. It never read
// a board — it hand-builds a `TaskCardView` and asks `serde_json` what keys come out,
// which is a shape question about three types declared in `db/rows.rs`, the exact
// subject of [`rows`]. It moved when `board.rs` passed its size ratchet, because the
// sanctioned answer to that red is a subject split and not a threshold bump.
//
// `support` is declared FIRST, and the `#[macro_use]` attribute is what makes the
// order matter. It is NOT needed by anything inside `support.rs`: the
// `SCHEMA_WITHOUT_*` / `SCHEMA_PRE_TASK_BOARD_CONFIG` fixtures are built by
// `legacy_batch!` INSIDE that file, below the macro, and a `macro_rules!` is already
// visible to the rest of the module that declares it without any attribute. What the
// attribute is load-bearing for is the CHILDREN: it puts `support`'s macros into the
// textual macro scope of the `mod` list that follows, so a child may spell
// `legacy_batch!` / `legacy_*!` in its own fixture. Measured: moving the declaration
// below the `mod` list breaks a child that uses a macro — the compiler prints
// `error: cannot find macro `legacy_sessions_complete` in this scope`, with NO error
// code attached (an earlier version of this comment quoted `E0658`, which this
// toolchain never emits for it — the message is bare `error:`), and every failure lands
// in the CHILD (`tests/stage_lifecycle.rs`, which spells
// `SCHEMA_PRE_TASK_BOARD_CONFIG` from these macros; it was `tests/stages.rs` until the
// subject split named in the header above), never in `support.rs` itself. Keep it first.
#[macro_use]
mod support;

mod artifacts;
mod auto_guards;
mod board;
mod messages;
mod migrations;
mod open;
mod parent_link;
mod retention;
mod rows;
mod seams;
mod sessions;
mod spaces;
// The two SUBJECT children that replaced `stages.rs` — see the header above for
// why they carry subject names and not the production file's name.
mod stage_lifecycle;
mod stage_setters;
mod tasks;
mod workflow_runs;
