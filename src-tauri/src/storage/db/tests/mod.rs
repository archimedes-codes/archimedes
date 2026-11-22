//! The `db` test tree — ADR 0113's MIRROR of the production split: one child per
//! production sibling, same names, and [`support`] as the only non-mirror child.
//!
//! `mod.rs` above (`db/mod.rs`) keeps `Db::open`, `gate`, `SCHEMA` and
//! `LAST_ACTIVITY`, so [`open`] is the child that mirrors the parent; every other
//! child has a production sibling of the same name. `support` holds the fixtures
//! several subjects share — the raw-SQL probes and the legacy-schema fixtures.

// `support` is declared FIRST because the legacy-schema macros it defines are
// textual: a `macro_rules!` reaches the rest of the enclosing module only from its
// definition onward, and the `SCHEMA_WITHOUT_*` / `SCHEMA_PRE_TASK_BOARD_CONFIG`
// fixtures below it are built by `legacy_batch!`.
#[macro_use]
mod support;

mod artifacts;
mod board;
mod messages;
mod migrations;
mod open;
mod rows;
mod sessions;
mod spaces;
mod stages;
mod tasks;
