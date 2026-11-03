//! Crate-scoped test helpers for `fulcrum-core` (T5 plan, "Create files":
//! `lib.rs` — "module tree + re-export block + crate-scoped test helpers").
//!
//! WHY THIS EXISTS: the S1 modules moved WITH their `#[cfg(test)]` blocks (Step A
//! preserves them verbatim), and two of those blocks build their fixtures out of
//! `crate::test_support::ScratchDir` / `crate::test_support::env_lock`
//! (`debuglog.rs:135,148-149`, `fs_backend.rs:345-346`). `#[cfg(test)]` is
//! PER-CRATE: the desktop's `src-tauri/src/test_support.rs` does not exist inside
//! this crate's test build, and this crate may not depend on `archimedes_lib` to
//! reach it (that edge is the package cycle T5's ruling severs). So the helpers
//! the moved tests need live here, and the moved test bodies stay byte-identical —
//! their `crate::test_support::…` paths now resolve HERE instead.
//!
//! The API is the subset the moved tests actually touch, kept signature-identical
//! to the desktop's copy so a fixture reads the same on both sides of the seam:
//! `env_lock`, `ScratchDir::in_env_temp`, `path`, `to_path_buf`, and the
//! `Deref`/`AsRef<Path>` pair. The desktop's copy keeps the rest (`in_dir`,
//! `in_tmpfs`, `filesystem_root`, the tauri accessors) — it still serves the 35
//! desktop files that did not move.
//!
//! # The leak this guard exists for (#96)
//!
//! A fixture that hands back a bare `PathBuf` leaks its directory the moment an
//! assertion panics; one green run leaked 432 dirs into the temp dir until the
//! per-user quota exhausted (#96). Ownership is the fix. The `Drop` impl below is
//! the mechanism, and `a_scratch_dir_is_gone_when_its_owner_is_dropped` pins it —
//! the crate's own copy needs its own pin, because a duplicated helper that is
//! only tested in its ORIGINAL copy is untested where it is used. The run-level
//! proof stays where it was: `scripts/check-temp-dir-census.sh` counts the temp
//! dir after the whole suite, across both crates.

/// The shared lock serializing the global-state tests (the parallel test harness
/// runs all module tests concurrently; a process-global read by one test
/// mid-mutation by another would see the wrong value). Mirrors the desktop's
/// `ENV_LOCK`.
pub static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Acquire the env-mutation lock (poison-tolerant — a sibling test panicking
/// while holding it must not turn this test's failure into an opaque
/// `PoisonError` panic). `pub(crate)` + `#[cfg(test)]` for the same reason the
/// desktop's copy is: it is test-only, and either half of that gate missing on
/// its own would leave the other half reporting `dead_code`.
#[cfg(test)]
pub(crate) fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    std::sync::Mutex::lock(&ENV_LOCK).unwrap_or_else(|p| p.into_inner())
}

/// A scratch dir for ONE test, REMOVED when it is dropped. See the module docs
/// for why this is duplicated rather than imported, and #96 for why it exists.
///
/// NOT `Clone`, on purpose: a second owner would `remove_dir_all` the same path
/// twice. [`ScratchDir::to_path_buf`] is the escape hatch for a call site that
/// needs an owned path — but the dir still dies with the guard.
pub struct ScratchDir {
    path: std::path::PathBuf,
}

impl ScratchDir {
    /// The ambient temp dir (`std::env::temp_dir()`) — the base the guards this
    /// replaces already assumed writable. Panics only if `temp_dir()` itself is
    /// unwritable, which every one of those guards has always assumed.
    pub fn in_env_temp(prefix: &str, tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!("{prefix}{tag}-{}", uuid::Uuid::new_v4()));
        // `create_dir_all` IS the probe: a present-but-unwritable base must
        // report the failure here rather than at the first fixture write.
        std::fs::create_dir_all(&path).expect(
            "`std::env::temp_dir()` accepts a `create_dir_all` — the guards this \
             replaces already assumed it writable, so this is a carried-over \
             precondition rather than an invariant (`TMPDIR` can name a dir that \
             is not writable; that is the condition #96 describes)",
        );
        Self { path }
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    pub fn to_path_buf(&self) -> std::path::PathBuf {
        self.path.clone()
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

impl std::ops::Deref for ScratchDir {
    type Target = std::path::Path;
    fn deref(&self) -> &Self::Target {
        &self.path
    }
}

/// Load-bearing, not decoration: `std::fs::create_dir_all(&guard)` and the
/// `Some(&home)` → `Option<&Path>` coercion FAIL with
/// `` the trait bound `ScratchDir: AsRef<Path>` is not satisfied `` when only
/// `Deref` is present — the blanket `impl AsRef<U> for &T` needs `T: AsRef<U>`,
/// and `Deref` does not supply it. Both are required; `AsRef` alone does not
/// cover the method calls (`root.join(..)`) that `Deref` does.
impl AsRef<std::path::Path> for ScratchDir {
    fn as_ref(&self) -> &std::path::Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::ScratchDir;

    /// The mechanism the moved `debuglog`/`fs_backend` fixtures depend on: the
    /// guard removes its dir when its owner is dropped. A bare `PathBuf` has no
    /// `Drop`, so every panicking assertion leaked one dir (#96). This is the
    /// crate's OWN pin for the crate's own copy of the helper.
    #[test]
    fn a_scratch_dir_is_gone_when_its_owner_is_dropped() {
        let guard = ScratchDir::in_env_temp("fc-guard-", "drop");
        assert!(guard.path().is_dir(), "creating the guard made the dir");
        let captured = guard.to_path_buf();
        drop(guard);
        assert!(
            !captured.exists(),
            "the guard's `Drop` removed its dir — {captured:?} is gone"
        );
    }
}
