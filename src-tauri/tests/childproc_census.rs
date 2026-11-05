//! T8b/S8b.4-part-3c — the DESKTOP-side half of the child-process census.
//!
//! # Why this file exists
//!
//! `childproc`'s census (invariants A–D) used to police BOTH trees, because
//! `childproc` was a desktop module and the census walked
//! `crates/fulcrum-core/src` + `src-tauri/src`. `src-tauri/src/agent/childproc.rs`
//! no longer exists — `agent/mod.rs` re-exports the module from the crate — so the
//! census now walks crate code only, and **nothing on this side refused a raw
//! `Command::new(` in desktop production code**. The invariant was being held by
//! discipline, not by a guard. This file puts the guard back.
//!
//! # What is policed: invariant A, and ONLY invariant A
//!
//! **A — one constructor.** A raw `Command::new(` outside the sanctioned
//! constructor produces a child with **no `CREATE_NO_WINDOW`**, so it pops a
//! console window per command **on Windows** — a user-visible bug on a platform
//! this repo ships to, and one that is invisible from the Linux box every
//! developer (and this CI) runs on. That asymmetry is exactly why it needs a
//! guard rather than review.
//!
//! Invariants B, C and D were considered and deliberately NOT ported:
//!
//!   * **B (raw command-line appends / a second owner of `creation_flags`)** has
//!     **zero desktop sites**. Measured at this commit: `.creation_flags(`,
//!     `.raw_arg(` and `childproc::append_cmd_c(` appear NOWHERE under
//!     `src-tauri/` (code or prose), and the desktop's only argument append is
//!     `update.rs`'s `cmd.args(args)` — the safe argv-array form. A guard over an
//!     absent construct cannot fail, and a guard that cannot fail is a decoration;
//!     this roadmap has been burned repeatedly by that exact shape.
//!   * **C (Tool children start at EOF)** is about `tools/exec/**`, which is crate
//!     code now. Same for **D (the crash-log module resolves no data dir)**'s
//!     crate half. Both are policed where the code they guard lives: the crate's
//!     own CI.
//!
//! Only A's concern applies to code that REMAINS here.
//!
//! # Scope: `src-tauri/src`, never `src-tauri/tests`
//!
//! Test targets legitimately spawn processes — `tests/worker_smoke.rs` and
//! `tests/worker_stdin.rs` spawn their own binary via `CARGO_BIN_EXE_archimedes`.
//! Policing them would force exceptions and train people to widen the allowlist,
//! which is how a guard dies. This scan reads `src/` only. (It also inherits the
//! crate's `**/tests/` exclusion, which removes the seven `src/**/tests/*.rs`
//! files that live under `src/`.)

//! # Why a SECOND scanner exists, and why it must not be "consolidated"
//!
//! `is_comment` / `production_boundary` / `production_region` below are a small
//! re-derivation of the crate's `fulcrum_core::lint_scan`. That is deliberate, and
//! it is NOT the drift `lint_scan` was written to prevent.
//!
//! `lint_scan` is `#[cfg(test)]` (`fulcrum`'s `lib.rs:157`), and **`#[cfg(test)]`
//! does not survive into a dependency** — a test in this package cannot import it,
//! full stop. The alternative was to widen the crate's public surface to export a
//! source-text scanner so a DESKTOP test could reach it, which (a) puts the
//! desktop's test tooling inside the engine crate, inverting who owns what, and
//! (b) makes a public API out of something whose only consumer is one test across
//! a repo boundary. So: a local copy, ~40 lines, minimal, and pinned by
//! [`both_filters_are_load_bearing_and_each_has_a_live_witness_in_this_tree`] plus
//! [`the_needle_fires_on_planted_code`] so a divergence here is loud.
//!
//! `lint_scan` exists to stop a THIRD definition of "read the production region"
//! appearing INSIDE one crate, where they can silently disagree. These two live in
//! different packages, in different repos, with different scopes and different
//! needles — the crate's reads crate sources and knows `SELF = childproc.rs`;
//! this one knows `src-tauri/src` and has no `SELF` at all, because the sanctioned
//! constructor is no longer desktop code. "Consolidating" them would require the
//! crate to own the desktop's paths, and would break BOTH census scopes to save
//! forty lines. If you are here to deduplicate: don't.

use std::path::{Path, PathBuf};

/// The forbidden token: a raw child-process constructor. Deliberately the bare
/// `Command::new(` rather than `std::process::Command::new(`, because
/// `tokio::process::Command::new(` is the SAME bug — tokio's builder needs the
/// same `creation_flags` via `CommandExt`, and forgetting them on either type
/// pops the Windows console window.
const RAW_CONSTRUCTOR: &str = "Command::new(";

/// The ONE sanctioned way for desktop production code to build a child: the
/// crate's constructor, reached through `agent/mod.rs`'s re-export. It owns the
/// `CREATE_NO_WINDOW` flag, so a caller cannot forget it.
const SANCTIONED_CONSTRUCTOR: &str = "childproc::command_std(";

/// One surviving line of a production region: its 1-based number in the file, so
/// a violation reads as `file:line`.
struct SourceLine {
    line: usize,
    text: String,
}

/// Whether a trimmed line is COMMENT text, which the census ignores. Mirrors the
/// crate's `lint_scan::is_comment` — including the `*` prefix, which covers
/// block-comment continuation lines. Not cosmetic: `update.rs` carries two `///`
/// lines that NAME `Command::new(` while describing Tauri's unflagged spawn, so a
/// rule that counted prose would be a permanent false positive.
fn is_comment(trimmed: &str) -> bool {
    ["//", "///", "//!", "/*", "*", "*/"]
        .iter()
        .any(|prefix| trimmed.starts_with(prefix))
}

/// The line index the production region ends at: the first line whose TRIMMED
/// text STARTS WITH `#[cfg(test)]` and is not itself a comment.
///
/// Item position, not "the line contains the token". A boundary that merely
/// CONTAINS the token is prose: `src/test_support.rs` names `#[cfg(test)]` in a
/// `//!` doc on line 7 and has its real attribute on line 21, and
/// `src/agent/harness/trust.rs` names it in a comment with NO test module at all
/// — under a contains-rule that file's production region would be 66 lines
/// instead of its full length, i.e. the scan would go quietly blind on it.
fn production_boundary(lines: &[&str]) -> Option<usize> {
    lines.iter().position(|l| {
        let trimmed = l.trim();
        trimmed.starts_with("#[cfg(test)]") && !is_comment(trimmed)
    })
}

/// The production region of a file given its lines: every line before
/// [`production_boundary`], comments already dropped. Split out from
/// [`production_region`] so the needle-integrity test can drive it with synthetic
/// lines and no I/O.
fn production_region_lines(lines: &[&str]) -> Vec<SourceLine> {
    let end = production_boundary(lines).unwrap_or(lines.len());
    let mut region = Vec::new();
    for (idx, raw) in lines[..end].iter().enumerate() {
        if is_comment(raw.trim()) {
            continue;
        }
        region.push(SourceLine {
            line: idx + 1,
            text: raw.to_string(),
        });
    }
    region
}

/// `src-tauri/` — anchored on `CARGO_MANIFEST_DIR`, NEVER on a level-counting
/// `.parent()`. The crate's own census had to learn this the hard way when the
/// crate left the workspace and its depth changed under it.
fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Every `*.rs` under `dir`, recursively, sorted so a violation report is
/// reproducible. Hand-rolled `read_dir` because a test does not get to add a
/// dependency (`walkdir` IS a dependency of the app but not of this target's
/// needs — and the crate's census set the precedent). Symlinked dirs are not
/// followed, so a link cycle cannot hang it.
fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries =
        std::fs::read_dir(dir).unwrap_or_else(|e| panic!("the census cannot read {dir:?}: {e}"));
    for entry in entries {
        let entry =
            entry.unwrap_or_else(|e| panic!("the census cannot read an entry of {dir:?}: {e}"));
        let path = entry.path();
        let file_type = entry
            .file_type()
            .unwrap_or_else(|e| panic!("the census cannot stat {}: {e}", path.display()));
        if file_type.is_dir() {
            rust_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

/// The crate's scope rule, mirrored: `**/tests.rs` and anything under `/tests/`
/// has NO production region — a test target is not production code.
fn is_test_target(path: &Path) -> bool {
    let norm = path.to_string_lossy().replace('\\', "/");
    norm.ends_with("/tests.rs") || norm == "tests.rs" || norm.contains("/tests/")
}

/// Read one file's production region. Panics on an unreadable file rather than
/// skipping it: a census that quietly stops at the first odd file is a census
/// that passes for the wrong reason.
fn production_region(path: &Path) -> Vec<SourceLine> {
    if is_test_target(path) {
        return Vec::new();
    }
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("the census cannot read {}: {e}", path.display()));
    production_region_lines(&text.lines().collect::<Vec<_>>())
}

/// The whole corpus: every `*.rs` under `src-tauri/src`, as
/// `(path, production region)` pairs sorted by path.
fn scan_src() -> Vec<(PathBuf, Vec<SourceLine>)> {
    let root = manifest_dir().join("src");
    let mut paths = Vec::new();
    rust_files(&root, &mut paths);
    paths.sort();
    paths
        .into_iter()
        .map(|path| (path.clone(), production_region(&path)))
        .collect()
}

/// `file:line` for every production-region line holding the raw constructor.
///
/// No allowlist: `childproc` — the one file the crate's census exempts as `SELF`
/// — is not desktop code any more, so there is nothing here to exempt. If the
/// constructor ever comes BACK to this tree, exempt it BY PATH and only then.
fn raw_constructors(regions: &[(PathBuf, Vec<SourceLine>)]) -> Vec<String> {
    let mut hits = Vec::new();
    for (path, region) in regions {
        for line in region.iter().filter(|l| l.text.contains(RAW_CONSTRUCTOR)) {
            hits.push(format!("{}:{}", path.display(), line.line));
        }
    }
    hits
}

/// The failure text, built by ONE function so the integrity test below asserts on
/// the message the guard ACTUALLY prints rather than on a copy that can drift
/// away from it. A red that names only a rule sends the reader to a debate; this
/// one names the consequence (a console window per command on Windows) and the
/// fix, because the bug is invisible from Linux and the reader will not have seen
/// it.
///
/// **Why this file's own prose is safe carrying the literal.** The hazard with a
/// self-naming diagnostic is a scanner that reads its own file; this scan is
/// rooted at `src-tauri/src` and this file is `src-tauri/tests/childproc_census.rs`,
/// outside the walked tree — and `is_test_target` would exclude it anyway. So the
/// message can name `Command::new(` verbatim, which it must to be a useful error.
fn violation_message(offenders: &[String]) -> String {
    format!(
        "Invariant A (one child constructor): desktop production code builds a raw \
         `Command` at {offenders:?}. That child gets NO `CREATE_NO_WINDOW`, so it pops a \
         CONSOLE WINDOW PER COMMAND ON WINDOWS — a user-visible bug on a platform this \
         repo ships to, and one no Linux run will ever show. Build the child through \
         `crate::agent::childproc::command_std(path)` (or `command`/`command_tokio` for \
         the async paths), which owns the flag; `childproc` is re-exported from \
         `fulcrum_core` by `agent/mod.rs`."
    )
}

#[test]
fn production_code_builds_no_raw_command_constructor() {
    let corpus = scan_src();

    // ── Vacuity floors FIRST. `src-tauri/src` holds 52 `.rs` files and ~7.9k
    // production code lines at this commit; both floors sit far below that, so
    // they are a BLIND-WALK tripwire, not a count pin: adding a file can never
    // redden them, but a walk that resolves somewhere else, stops descending, or
    // truncates every file at a prose `#[cfg(test)]` reads ~nothing and would
    // otherwise certify an empty corpus. Every ABSENCE invariant below is true of
    // nothing if this passes on a blind scan.
    let walked = corpus.len();
    let read_lines: usize = corpus.iter().map(|(_, r)| r.len()).sum();
    assert!(
        walked >= 40,
        "the desktop census walked only {walked} `.rs` files under {:?} — VACUOUS \
         (52 at this commit). A guard that reads nothing reports a clean bill of \
         health for an empty corpus; check the CARGO_MANIFEST_DIR anchor.",
        manifest_dir().join("src")
    );
    assert!(
        read_lines >= 6000,
        "the desktop census kept only {read_lines} production code lines across {walked} \
         files — VACUOUS (~7865 at this commit). Either the walk is shallow or the \
         `#[cfg(test)]` boundary rule is truncating files it should not read.",
    );

    // ── The eyesight witness, per the crate's own shape: the scan must see the
    // call the invariant exists to watch, not merely many files. Measured EXACTLY
    // 1 `command_std` call in 1 file on the desktop root.
    let std_calls: usize = corpus
        .iter()
        .map(|(_, region)| {
            region
                .iter()
                .filter(|l| l.text.contains(SANCTIONED_CONSTRUCTOR))
                .count()
        })
        .sum();
    assert!(
        std_calls >= 1,
        "the desktop census saw ZERO `childproc::command_std(` calls in {} production \
         regions — either the match string drifted from the crate's API or the only \
         sanctioned desktop call site is gone, and then invariant A would be true of \
         nothing.",
        corpus.len()
    );

    let offenders = raw_constructors(&corpus);
    assert!(offenders.is_empty(), "{}", violation_message(&offenders));
}

#[test]
fn the_scan_is_not_blind_the_whole_file_read_finds_the_raw_constructor() {
    // ── POSITIVE CONTROL. `src/commands/update.rs` contains a legitimate raw
    // constructor — inside its `#[cfg(test)]` module, where it proves the
    // `EnvPatch` seeding. A whole-file read MUST find it. If this fails, the
    // path anchor or the token is wrong, and every absence assertion below is
    // vacuously green.
    let path = manifest_dir().join("src/commands/update.rs");
    let whole = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{} must be readable: {e}", path.display()));
    assert!(
        whole.contains("std::process::Command::new(EXE_IN_MOUNT)"),
        "the positive control is broken: {} does not contain the raw constructor this \
         census exists to distinguish. Either the file moved, the test that proves the \
         EnvPatch seeding was deleted, or the token drifted — and then \
         production_code_builds_no_raw_command_constructor passes on nothing.",
        path.display()
    );
    assert!(
        whole.contains(RAW_CONSTRUCTOR),
        "the assembled needle `{RAW_CONSTRUCTOR}` does not appear in {} even though the \
         raw constructor does — the needle is not the token it stands for.",
        path.display()
    );
}

#[test]
fn the_truncation_works_and_the_sanctioned_call_site_survives_it() {
    // ── The other half of the same file: the PRODUCTION region must NOT see that
    // constructor, and must still see the sanctioned one. One file, two
    // opposite-shaped assertions — the truncation is doing exactly its job and no
    // more.
    let path = manifest_dir().join("src/commands/update.rs");
    let region = production_region(&path);
    let raw: Vec<usize> = region
        .iter()
        .filter(|l| l.text.contains(RAW_CONSTRUCTOR))
        .map(|l| l.line)
        .collect();
    assert!(
        raw.is_empty(),
        "the production region of {} still holds the raw constructor at {raw:?} — the \
         production region is not truncating at the `#[cfg(test)]` module, so this guard \
         fails on LEGITIMATE test code and will get widened into uselessness.",
        path.display()
    );
    let sanctioned: Vec<usize> = region
        .iter()
        .filter(|l| l.text.contains(SANCTIONED_CONSTRUCTOR))
        .map(|l| l.line)
        .collect();
    assert_eq!(
        sanctioned.len(),
        1,
        "the production region of {} holds {} `childproc::command_std(` calls, expected \
         exactly 1 (the Linux relaunch). 0 means the only real desktop call site was \
         deleted and invariant A silently became 'nothing constructs a child here', \
         which is not the truth; >1 means a second relaunch path appeared.",
        path.display(),
        sanctioned.len()
    );
}

#[test]
fn both_filters_are_load_bearing_and_each_has_a_live_witness_in_this_tree() {
    // ── Filter 1: comment stripping. `update.rs`'s production region contains
    // `Command::new(` in PROSE (two `///` lines describing Tauri's unflagged
    // spawn). Comment-stripping is what keeps that from being a permanent false
    // positive. Measured, not assumed: the unfiltered region trips, the filtered
    // one does not.
    let path = manifest_dir().join("src/commands/update.rs");
    let text = std::fs::read_to_string(&path).unwrap();
    let lines = text.lines().collect::<Vec<_>>();
    let end = production_boundary(&lines).expect("update.rs has a test module");
    let unfiltered = (0..end)
        .filter(|i| lines[*i].contains(RAW_CONSTRUCTOR))
        .count();
    let filtered = production_region(&path)
        .iter()
        .filter(|l| l.text.contains(RAW_CONSTRUCTOR))
        .count();
    assert!(
        unfiltered > 0 && filtered == 0,
        "the comment filter is not doing its job on {}: {unfiltered} prose mentions \
         survive to {filtered} after filtering. Expected prose > 0 and code == 0.",
        path.display()
    );

    // ── Filter 2: ITEM POSITION, not substring. `src/test_support.rs` names
    // `#[cfg(test)]` in a module doc (line 7) and carries its real attribute on
    // line 21; a substring rule truncates at 7 and keeps 3 lines. `src/agent/
    // harness/trust.rs` names it in a comment and has NO test module at all — a
    // substring rule truncates it to 66 lines and reports "clean" for a file it
    // barely read.
    let support = manifest_dir().join("src/test_support.rs");
    let support_text = std::fs::read_to_string(&support).unwrap();
    let support_lines = support_text.lines().collect::<Vec<_>>();
    let substring = support_lines
        .iter()
        .position(|l| l.contains("#[cfg(test)]"))
        .expect("test_support.rs names #[cfg(test)] in prose");
    let item_position =
        production_boundary(&support_lines).expect("test_support.rs has a real one");
    assert!(
        substring < item_position,
        "expected {} to hold a prose `#[cfg(test)]` (line {}) BEFORE the item-position \
         attribute (line {}) — that pair is this rule's witness. If the file changed, \
         re-derive the witness; do not delete the assertion.",
        support.display(),
        substring + 1,
        item_position + 1
    );
    let trust = manifest_dir().join("src/agent/harness/trust.rs");
    let trust_text = std::fs::read_to_string(&trust).unwrap();
    assert!(
        trust_text.contains("#[cfg(test)]"),
        "{} is supposed to be the file that names `#[cfg(test)]` in prose with no test \
         module — re-derive this witness if that changed.",
        trust.display()
    );
    assert_eq!(
        production_boundary(&trust_text.lines().collect::<Vec<_>>()),
        None,
        "{} has NO item-position `#[cfg(test)]`, so its whole file is production. A \
         substring boundary would truncate it and go silently blind.",
        trust.display()
    );
}

#[test]
fn the_needle_fires_on_planted_code() {
    // ── Needle integrity, with no I/O and no temp dirs: drive the region
    // extractor with synthetic lines and demand it reports the planted site.
    // Without this, a typo'd needle (`Command::new` without the paren, say) makes
    // the whole census permanently green.
    let planted = [
        "fn relaunch(path: &str) {",
        "    let mut cmd = std::process::Command::new(path);",
        "    let _ = cmd.spawn();",
        "}",
        "#[cfg(test)]",
        "mod tests {",
        "    fn also_raw() -> std::process::Command {",
        "        std::process::Command::new(\"x\")",
        "    }",
        "}",
    ];
    let region = production_region_lines(&planted);
    let hits: Vec<usize> = region
        .iter()
        .filter(|l| l.text.contains(RAW_CONSTRUCTOR))
        .map(|l| l.line)
        .collect();
    assert_eq!(
        hits,
        vec![2],
        "the scanner must report the planted production site (line 2) and NOT the \
         test-module site (line 8) — this is the guard's teeth, exercised without \
         touching the tree. Hits were {hits:?}."
    );
    // And the diagnostic must carry the CONSEQUENCE, or a red sends nobody to the
    // bug — asserted against the real message builder, not a copy of it.
    let message = violation_message(
        &hits
            .iter()
            .map(|l| format!("planted.rs:{l}"))
            .collect::<Vec<_>>(),
    );
    assert!(
        message.contains("CREATE_NO_WINDOW")
            && message.to_lowercase().contains("windows")
            && message.contains("planted.rs:2"),
        "the failure text must name the file:line AND the consequence (no \
         `CREATE_NO_WINDOW` → a console window per command on Windows): {message}"
    );
}

#[test]
fn the_guard_cannot_police_its_own_file() {
    // ── The self-naming hazard, checked structurally instead of by avoiding the
    // literal. This file's diagnostics MUST contain `Command::new(` to be useful
    // errors, so a scanner that read this file would be red on its own message.
    // The scan is rooted at `src-tauri/src`; this file lives in `src-tauri/tests`,
    // which is both outside the walked tree and excluded by `is_test_target`.
    // Assert both, so moving this file INTO `src/` (the way it would start
    // self-tripping) reddens something.
    // `file!()` is relative to the WORKSPACE root (`src-tauri/tests/…`), so
    // `CARGO_MANIFEST_DIR` + the path's own `tests/…` half is the honest absolute
    // form. Do NOT `manifest_dir().join(file!())` — that double-counts `src-tauri`.
    let here = manifest_dir().join("tests/childproc_census.rs");
    let src_root = manifest_dir().join("src");
    assert!(
        file!()
            .replace('\\', "/")
            .ends_with("tests/childproc_census.rs"),
        "`file!()` reports {}/{} — this guard's self-skip depends on living in a test \
         target, outside the walked `src/` tree.",
        env!("CARGO_CRATE_NAME"),
        file!()
    );
    assert!(
        !here.starts_with(&src_root),
        "{} now lives under {} — the census would read its own diagnostics as \
         violations. Move it back out of the scanned tree, or exempt it by path and \
         say why.",
        here.display(),
        src_root.display()
    );
    assert!(
        is_test_target(&here) || here.starts_with(manifest_dir().join("tests")),
        "{} is neither a `**/tests/` path nor under `src-tauri/tests`, so the scope \
         rule no longer keeps this file's own `Command::new(` prose out of the corpus.",
        here.display()
    );
    // And the corpus really does exclude it — the walk, not the reasoning.
    assert!(
        !scan_src()
            .iter()
            .any(|(path, _)| path.file_name().and_then(|n| n.to_str())
                == Some("childproc_census.rs")),
        "the census walked its own file, so its diagnostic text would be corpus"
    );
}
