//! The desktop half of the TRUST lookup seam (ADR 0010/0025) — the SPLIT,
//! not the move (T5/S5a, SEAM 1).
//!
//! `TrustSource` (the trait) and `StaticTrustSource` (the Worker's flag)
//! moved to `crates/fulcrum-core/src/trust.rs`, because the crate's
//! permission gate names the trait and a crate file cannot name a desktop
//! module. What stayed HERE is the one implementation that holds a
//! `storage::Db`:
//!
//!   * `rusqlite` is not in the crate's dependency graph — `DbError` wraps
//!     `rusqlite::Error` and therefore cannot move (the plan's Step B-bis),
//!     so nothing that touches a `Db` can cross the boundary;
//!   * reaching `crate::storage` from the crate would be the
//!     `fulcrum-harness → archimedes_lib` edge that IS the package cycle T5
//!     exists to sever.
//!
//! So the desktop implements the crate's trait, exactly as `web/render.rs`
//! implements the crate's `RenderRequester` (S2), as `provider_headers`
//! left its directory behind (S3), and as `open.rs` implements the crate's
//! `OpenRequester` (S3). Desktop→crate is the allowed direction.
//!
//! Both crate spellings are re-exported below, so `harness/mod.rs`'s
//! `pub use trust::{SqliteTrustSource, StaticTrustSource, TrustSource};`
//! and every `crate::agent::harness::trust::…` path resolve UNCHANGED —
//! the re-export seam (Step A.2), one level down inside `harness`.
//!
//! # The pin
//!
//! `archimedes_lib::agent::harness::trust::SqliteTrustSource` satisfying
//! `fulcrum_harness::trust::TrustSource` is asserted by
//! `tests/fulcrum_seams.rs::sqlite_trust_source_satisfies_the_crate_trait`,
//! and the behaviour test that used to sit in this file
//! (`sqlite_trust_source_reads_the_space_flag`) relocated verbatim beside
//! it. Both CONSTRUCT the type — an impl nobody instantiates proves
//! nothing (the S4 ruling).

use std::sync::Arc;

use crate::storage::Db;

// The two pure halves, re-exported so the desktop's pre-S5a spellings keep
// resolving: `harness/mod.rs:62` names all three, `worker/core.rs:30`
// imports `StaticTrustSource` + `TrustSource` from this path, and
// `harness/loop.rs:45` imports `TrustSource` from it.
pub use fulcrum_harness::trust::{StaticTrustSource, TrustSource};

/// The SQLite trust source (the current `db.space_trusted` lookup, moved
/// verbatim — a canonicalize failure or a missing row is `false` —
/// untrusted, fail-closed).
pub struct SqliteTrustSource(Arc<Db>);

impl SqliteTrustSource {
    pub fn new(db: Arc<Db>) -> Self {
        Self(db)
    }
}

/// The desktop's implementation of the crate's TRUST seam — the half the
/// crate cannot hold, because it holds a `Db`.
impl TrustSource for SqliteTrustSource {
    fn is_trusted(&self, cwd: &std::path::Path) -> bool {
        self.0.space_trusted(cwd).unwrap_or(false)
    }
}

// The two `Db`-backed tests that used to live in this file could not come
// along: `#[cfg(test)]` does not survive into an rlib (Step A.4), and the
// crate cannot reach `storage::Db` regardless. They relocated VERBATIM to
// `src-tauri/tests/fulcrum_seams.rs` — the side that sees both halves.
