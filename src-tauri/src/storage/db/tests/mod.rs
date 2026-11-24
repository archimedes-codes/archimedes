//! The `db` test tree — ADR 0113's MIRROR of the production split: one child per
//! production sibling, same names, and [`support`] as the only non-mirror child.
//!
//! `mod.rs` above (`db/mod.rs`) keeps `Db::open`, `gate`, `SCHEMA` and
//! `LAST_ACTIVITY`, so [`open`] is the child that mirrors the parent; every other
//! child has a production sibling of the same name. `support` holds the fixtures
//! several subjects share — the raw-SQL probes and the legacy-schema fixtures.

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
// in the CHILD (`tests/stages.rs`), never in `support.rs` itself. Keep it first.
#[macro_use]
mod support;

mod artifacts;
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
mod stages;
mod tasks;
