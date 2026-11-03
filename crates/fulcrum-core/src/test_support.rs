//! Crate-scoped test helpers for `fulcrum-core` (T5 plan, "Create files":
//! `lib.rs` — "module tree + re-export block + crate-scoped test helpers").
//!
//! WHY THIS EXISTS: the S1/S2 modules moved WITH their `#[cfg(test)]` blocks
//! (Step A preserves them verbatim), and those blocks build their fixtures out of
//! `crate::test_support::ScratchDir` / `crate::test_support::env_lock` /
//! `crate::test_support::filesystem_root`. `#[cfg(test)]` is PER-CRATE: the
//! desktop's `src-tauri/src/test_support.rs` does not exist inside this crate's
//! test build, and this crate may not depend on `archimedes_lib` to reach it
//! (that edge is the package cycle T5's ruling severs). So the helpers the moved
//! tests need live here, and the moved test bodies stay byte-identical — their
//! `crate::test_support::…` paths now resolve HERE instead.
//!
//! The API is the subset the moved tests actually touch, kept SIGNATURE-IDENTICAL
//! to the desktop's copy so a fixture reads the same on both sides of the seam:
//! `env_lock`, `filesystem_root`, and `ScratchDir::{in_dir, in_env_temp, path,
//! display, to_path_buf}` plus the `Deref`/`AsRef<Path>` pair. The desktop's copy
//! keeps the rest (`in_tmpfs`/`tmpfs_base_candidates` — no moved test calls them,
//! measured — and the tauri accessors, which this crate must not name).
//!
//! # The one lock per process, and why two copies are safe
//!
//! `ENV_LOCK` serialises tests that mutate process-global state (`$HOME`, the
//! web API-key vars). S2 leaves TWO copies of that static in the workspace: this
//! one and the desktop's. That is safe, and the reason is load-bearing enough to
//! pin here rather than leave to luck:
//!
//!   * This module is `#[cfg(test)]`, so it is compiled into `fulcrum-core`'s own
//!     unit-test binary and is NOT in the rlib. A desktop test therefore CANNOT
//!     reach it (measured: zero `fulcrum_core::test_support` references under
//!     `src-tauri/tests/`), so the two locks can never both be held in one
//!     process — which is what an `ENV_LOCK` self-deadlock would require.
//!   * `cargo test` runs each test BINARY to completion before starting the next
//!     (cargo parallelises *within* a binary via the libtest harness, and
//!     *across* builds, never across two running test binaries; only `nextest`
//!     does that, and this repo runs plain `cargo test`). So the crate's
//!     `$HOME`-mutating tests and the desktop's never overlap in wall-clock time
//!     either.
//!
//! The hazard this note exists for is real and was hit by S3's predecessor (an
//! `ENV_LOCK` self-deadlock): if this module is ever ungated from `#[cfg(test)]`
//! so an integration test CAN import it, the first bullet above stops holding and
//! the two locks must be unified into one static that both crates reference.
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
/// `ENV_LOCK`; see the module docs for why two copies do not deadlock.
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

/// The shared cargo `target/debug` directory — the ONE place in this crate that
/// resolves it, and the reason T5/S2 put it here was so T5/S3 would not have to
/// resolve it eight times.
///
/// # The trap
///
/// T4 re-rooted every fixture path to `env!("CARGO_MANIFEST_DIR")`, then its
/// `.parent()`, then `target/debug/<bin>`. That was correct while the files lived
/// in `src-tauri/` (parent = the repo root). Once a file moves to
/// `crates/fulcrum-core`, `CARGO_MANIFEST_DIR` is `…/crates/fulcrum-core` and
/// `.parent()` is `…/crates`, so the path names `crates/target/debug/<bin>` —
/// which does not exist. A test that spawns it fails with ENOENT; a `let _ =`
/// site fails quietly.
///
/// # Why the desktop's own pin cannot catch this
///
/// T4's `fixture_path_resolves_to_the_workspace_root_target` lives in
/// `worker/client.rs`, which stays desktop through T8 — it keeps passing while
/// every moved fixture path is broken. The pin that rules this helper lives in
/// `childproc.rs` (`target_debug_dir_is_where_cargo_actually_builds`) and compares
/// the resolution against `current_exe()`'s real location, so it cannot go green
/// on a wrong level count.
///
/// # Consumers (T5/S3, measured)
///
/// `mcp/stdio.rs::fake_mcp_bin`, `mcp/tool.rs::fake_bin`, and three
/// `fake_mcp_stdio` sites in `mcp/manager.rs`'s tests. None of those spawners
/// carries a vacuity guard, which is why the pin above is the only thing standing
/// between a wrong root and a silently-green suite.
#[cfg(test)]
pub(crate) fn target_debug_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("crates/fulcrum-core has a grandparent (the repo root)")
        .join("target")
        .join("debug")
}

/// (test only) The broadest rule path a test can name — the one root that
/// really does contain every canonical absolute path ON THIS PLATFORM.
///
/// Moved verbatim from the desktop's copy in T5/S2 because two moved tests call
/// it (`policy.rs`'s and `tools/exec/tests/policy.rs`'s maximum-reach rule
/// fixtures). The reason it exists is a platform fact, restated here so the crate
/// copy carries its own justification: a test that wants "a rule with maximum
/// reach" reaches for the literal `"/"`, and that is a Unix fact, not a platform
/// one. On Windows a lone `/` is only the CURRENT DRIVE'S root in the current
/// working directory's spelling, and it is not a component prefix of the verbatim
/// (`\\?\C:\…`) form that `canonicalize` hands back — so a `"/"` rule matches
/// NOTHING and a test that asserts it refuses something reddens there while
/// staying green on Linux and macOS.
///
/// `for_path` is a path the test is actually working with (its scratch home or
/// `cwd`); the root is taken from ITS OWN components, so the two land on the same
/// drive AND on the same verbatim spelling the shared canonicalizer
/// (`crate::fs_backend::canonicalize_lenient`) produces for it — which is the
/// property the caller needs for a component-prefix compare to hold.
///
/// Strict `canonicalize()` (not the shared lenient one) is deliberately the only
/// resolver used, exactly as in the desktop's copy: a drive root derived from a
/// real path always EXISTS, and on Windows the drive root spelled `C:\` carries a
/// `Disk` prefix component while the canonicalized target carries a
/// `VerbatimDisk` one, so the raw spelling would fail the very compare this
/// exists to satisfy. Canonicalizing lands both sides in the verbatim form.
#[cfg(test)]
pub(crate) fn filesystem_root(for_path: &std::path::Path) -> std::path::PathBuf {
    #[cfg(not(windows))]
    {
        // On unix the root is the one true `/`, and every canonical absolute
        // path is under it. `for_path` is irrelevant here, but the signature
        // stays uniform so the call sites do not need a `cfg`.
        let _ = for_path;
        std::path::PathBuf::from("/")
    }
    #[cfg(windows)]
    {
        // `Prefix`(e.g. `C:`) then `RootDir`(`\`) is the drive root — the
        // component-wise root, not a string slice, so a UNC path yields its
        // own server/share root rather than a mangled `C:\`.
        let mut root = std::path::PathBuf::new();
        for component in for_path.components() {
            match component {
                std::path::Component::Prefix(prefix) => root.push(prefix.as_os_str()),
                std::path::Component::RootDir => {
                    root.push(component.as_os_str());
                    break;
                }
                // Anything else is below the root: stop.
                _ => break,
            }
        }
        assert!(
            !root.as_os_str().is_empty(),
            "`{for_path:?}` is rooted on a drive — a relative path has no root to name"
        );
        root.canonicalize().unwrap_or(root)
    }
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
    /// A fresh dir directly inside `base`, named `{prefix}{tag}-{uuid}`.
    /// `None` when `base` cannot accept it — the caller decides whether that
    /// means "skip" or "panic". The `tools/sandbox` fixtures are the crate's
    /// reason this constructor exists at all: their base must be a probe-verified
    /// tmpfs OUTSIDE the sandbox write allow-list, and a fallback to
    /// `std::env::temp_dir()` would put them inside it, which makes ~13
    /// confinement tests pass VACUOUSLY. Hence `None`, not a fallback.
    pub fn in_dir(base: &std::path::Path, prefix: &str, tag: &str) -> Option<Self> {
        let path = base.join(format!("{prefix}{tag}-{}", uuid::Uuid::new_v4()));
        // `create_dir_all` IS the probe: a present-but-unwritable base must
        // report `None` rather than panic a fixture (the lesson of the prior art,
        // which checked `is_dir()` first and could still fail the write).
        std::fs::create_dir_all(&path).ok()?;
        Some(Self { path })
    }

    /// The ambient temp dir (`std::env::temp_dir()`) — the base the guards this
    /// replaces already assumed writable. Panics only if `temp_dir()` itself is
    /// unwritable, which every one of those guards has always assumed.
    pub fn in_env_temp(prefix: &str, tag: &str) -> Self {
        Self::in_dir(&std::env::temp_dir(), prefix, tag).expect(
            "`std::env::temp_dir()` accepts a `create_dir_all` — the guards this \
             replaces already assumed it writable, so this is a carried-over \
             precondition rather than an invariant (`TMPDIR` can name a dir that \
             is not writable; that is the condition #96 describes)",
        )
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    /// The dir as a shell-quotable string (the tags are uuid-derived, so no
    /// quoting character can appear) — the `tools/sandbox` tests' `display()`
    /// needs this on the inner guard, not just on their own `TmpDir` wrapper.
    pub fn display(&self) -> String {
        self.path.display().to_string()
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

    /// The mechanism the moved fixtures depend on: the guard removes its dir when
    /// its owner is dropped. A bare `PathBuf` has no `Drop`, so every panicking
    /// assertion leaked one dir (#96). This is the crate's OWN pin for the
    /// crate's own copy of the helper.
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

    /// `in_dir` is the constructor the sandbox fixtures use because it is the one
    /// that REFUSES rather than falling back. Pinning the refusal is what keeps a
    /// future "simplify it to panic-and-fallback" from silently making ~13
    /// confinement tests vacuous: a sandbox fixture rooted in `/tmp` sits INSIDE
    /// the write allow-list, so a denied write would be denied for the wrong
    /// reason and the test would still be green.
    #[test]
    fn in_dir_reports_none_when_the_base_cannot_accept_it() {
        // A path whose PARENT is a regular file: no `create_dir_all` can succeed
        // under it, on any platform, without touching the ambient temp dir.
        let blocker = ScratchDir::in_env_temp("fc-guard-", "blocker");
        let not_a_dir = blocker.path().join("a-file");
        std::fs::write(&not_a_dir, b"x").unwrap();

        assert!(
            ScratchDir::in_dir(&not_a_dir, "fc-guard-", "unwritable").is_none(),
            "`in_dir` must report `None` for an unusable base — the sandbox \
             fixtures branch on `None` to SKIP loudly, and a fallback or a panic \
             would change what those tests prove"
        );

        // And the happy path, so the `None` above is about the base and not
        // about the constructor being broken.
        let base = ScratchDir::in_env_temp("fc-guard-", "base");
        let inner = ScratchDir::in_dir(base.path(), "fc-guard-", "inside");
        let inner = inner.expect("a writable base accepts a dir");
        assert!(
            inner.path().starts_with(base.path()),
            "the dir lands inside the base it was given: {:?}",
            inner.path()
        );
        assert_eq!(
            inner.display(),
            inner.path().display().to_string(),
            "`display()` is the path's own rendering (the sandbox tests shell-quote it)"
        );
    }

    /// The naming contract the #96 census reads: `{prefix}{tag}-{uuid}`, and the
    /// uuid half must really vary — two tests asking for the SAME tag may not
    /// share a dir, or they delete each other's fixture.
    #[test]
    fn the_guard_names_the_dir_after_the_prefix_and_tag_it_is_given() {
        let a = ScratchDir::in_env_temp("fc-guard-", "naming");
        let name = a
            .path()
            .file_name()
            .expect("a scratch dir has a file name")
            .to_string_lossy()
            .into_owned();
        assert!(
            name.starts_with("fc-guard-naming-"),
            "the name must carry the prefix then the tag: {name}"
        );
        assert!(
            name.strip_prefix("fc-guard-naming-")
                .is_some_and(|uuid| !uuid.is_empty()),
            "the uuid segment must be present: {name}"
        );

        let b = ScratchDir::in_env_temp("fc-guard-", "naming");
        assert_ne!(
            a.path(),
            b.path(),
            "the SAME tag must still mint a DIFFERENT dir"
        );
    }
}
