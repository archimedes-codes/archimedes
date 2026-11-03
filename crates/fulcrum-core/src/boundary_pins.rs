//! The crate's boundary pins (plan Step C, §2c-bis's pin, and the S4 gate's
//! "the crate contains no `tauri` reference" test).
//!
//! ## Why these scan files instead of calling functions
//!
//! The properties they hold are ABSENCES — the crate does not read the desktop's
//! settings file, does not name the desktop UI framework, does not link a SQLite
//! driver or depend on the desktop package. An absence has no call site to test,
//! which is why the plan specifies a grep ("a crate-wide test that `grep -c
//! "load_settings\|settings.json" crates/fulcrum-core/src` is 0, so a future move
//! cannot reintroduce the read unnoticed") and why the S4 gate asks for the UI
//! framework one as "a test, not a hope". A grep living in a shell script nobody
//! runs is a weak guard; inside the test binary it runs on every `cargo test`.
//!
//! ## Why comments are STRIPPED, and why that is not cheating
//!
//! The raw grep is not 0 and cannot be: this crate's docs explain *why* `open.rs`
//! and `web/render.rs` stayed desktop ("the desktop's `crate::open` names tauri"),
//! and `config_types` explains why the settings loader stayed behind. Prose about a
//! forbidden thing is not the forbidden thing — the S3 gate recorded its two prose
//! hits as expected. So the pins match CODE.
//!
//! That is only honest if the stripper is real, so it removes line comments and
//! block comments and the pins count what survives. Two consequences, both
//! intended: a settings read in a function body is caught; the word in a `///` line
//! is not. The first is the point, and it is verified by
//! [`prose_is_stripped_but_code_is_not`], which feeds the stripper code it must
//! catch and requires it to catch it.
//!
//! ## The one literal exception, and why it is narrow
//!
//! `childproc.rs`'s source-root census asserts over real paths, and one of them is
//! the desktop package's DIRECTORY — `src-tauri` — which contains the UI
//! framework's name as a substring and always will. So the UI-framework scan
//! ignores string literals and nothing else. The blind spot cannot hide the thing
//! that matters: a dependency arrives through `Cargo.toml`, not through a string
//! literal, which is why
//! [`the_manifest_declares_no_forbidden_dependency`] is a separate pin.
//!
//! ## Why this file contains no forbidden identifier as a literal
//!
//! The scanner reads this file. The obvious fix — exempt this file — is a loophole:
//! an exempted file is one the invariant does not hold in. So instead every needle
//! is assembled at runtime via [`needle`] with ONE character written as a `\u{…}`
//! escape, which makes the SOURCE TEXT differ from the RUNTIME STRING while the
//! runtime string is the exact, unmodified identifier. [`the_needles_are_the_identifiers_they_stand_for`]
//! is the pin that keeps that trick honest.

use std::path::{Path, PathBuf};

/// Remove `//`, `///`, `//!` line comments and `/* */` block comments, leaving
/// code. Line-based and deliberately simple — it is not a Rust lexer and does not
/// need to be. Its job is to stop matching text a human wrote ABOUT a forbidden
/// name while still matching the name in a statement, and
/// [`prose_is_stripped_but_code_is_not`] is the pin that holds it to that.
fn strip_comments(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut in_block = false;
    for line in source.lines() {
        let trimmed = line.trim_start();
        if in_block {
            if let Some(rest) = trimmed.find("*/") {
                in_block = false;
                out.push_str(&trimmed[rest + 2..]);
                out.push('\n');
            }
            continue;
        }
        if trimmed.starts_with("/*") {
            if let Some(rest) = trimmed.find("*/") {
                out.push_str(&trimmed[rest + 2..]);
                out.push('\n');
            } else {
                in_block = true;
            }
            continue;
        }
        if trimmed.starts_with("//") {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Drop the contents of string literals, keeping the quotes. Its ONLY caller is
/// the UI-framework scan, for the one reason in the module docs: the source-root
/// census names the desktop package's directory.
fn strip_string_literals(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut in_string = false;
    let mut escaped = false;
    for ch in source.chars() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
                out.push('"');
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            out.push('"');
        } else {
            out.push(ch);
        }
    }
    out
}

/// A forbidden identifier, spelled with its FIRST character as an escape.
///
/// The assembled string is byte-identical to the plain literal — there is no
/// separator and no placeholder to strip — while this file's SOURCE never contains
/// it, so the scanner does not report the scanner. See the module docs for why this
/// beats exempting the file.
///
/// The escape is load-bearing and easy to get wrong: an earlier draft built needles
/// by JOINING parts with a separator character, which made every needle
/// unmatchable, and all three source scans then passed a deliberately planted
/// settings read and reported green. That is what
/// [`the_needles_are_the_identifiers_they_stand_for`] exists to prevent.
fn needle(escaped_first: char, rest: &str) -> String {
    format!("{escaped_first}{rest}")
}

/// The settings-file reader's name, the one the plan's grep is written against.
fn settings_loader_name() -> String {
    needle('\u{6c}', "oad_settings")
}

/// The settings file itself.
fn settings_file_name() -> String {
    needle('\u{73}', "ettings.json")
}

/// The settings writer's name (the other half of the disk boundary).
fn settings_writer_name() -> String {
    needle('\u{77}', "rite_settings")
}

/// The SQLite driver the crate must not link (Step B-bis: `DbError` cannot move
/// because it wraps the driver's error type, which is why `StoreError` exists).
fn sqlite_driver_name() -> String {
    needle('\u{72}', "usqlite")
}

/// The desktop package the crate must not import — the package cycle Step A
/// exists to sever.
fn desktop_package_name() -> String {
    needle('\u{61}', "rchimedes_lib")
}

/// The desktop UI framework the crate must not name (the master roadmap's own
/// decoupling criterion).
fn ui_framework_name() -> String {
    needle('\u{74}', "auri")
}

/// Every `.rs` file under this crate's `src/`, as (path, code-with-comments-gone).
fn crate_code() -> Vec<(PathBuf, String)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    assert!(root.is_dir(), "the crate's own src/ must exist: {root:?}");
    let mut found = Vec::new();
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap_or_else(|e| panic!("read_dir {dir:?}: {e}")) {
            let path = entry.expect("a dir entry").path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                let text = std::fs::read_to_string(&path)
                    .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
                found.push((path, strip_comments(&text)));
            }
        }
    }
    // The scan's OWN vacuity guard: a wrong root walks nothing and every pin in
    // this module then passes on an empty set — the failure mode this plan has
    // already been bitten by twice (the `CARGO_MANIFEST_DIR.parent()` fixture paths
    // after the move, and the census guard that quietly stopped covering moved
    // code).
    assert!(
        found.len() > 40,
        "the scan found only {} .rs files — a wrong root makes every boundary pin vacuous",
        found.len()
    );
    found
}

fn offenders(code: &[(PathBuf, String)], forbidden: &str) -> Vec<(PathBuf, String)> {
    code.iter()
        .filter(|(_, body)| body.contains(forbidden))
        .map(|(path, body)| {
            let line = body
                .lines()
                .find(|l| l.contains(forbidden))
                .unwrap_or("(the match spans lines)")
                .trim()
                .to_string();
            (path.clone(), line)
        })
        .collect()
}

/// Step C / §2c: the crate reads NO desktop config file. The settings loader is the
/// T3 disk boundary and it stayed in the desktop; a second reader appearing here
/// would silently undo T3 — the exact failure the REVIEW ROUND's CRITICAL finding
/// was about, and the reason the plan mandates this pin.
#[test]
fn no_code_reads_the_desktop_settings_file() {
    let code = crate_code();
    for forbidden in [
        settings_loader_name(),
        settings_writer_name(),
        settings_file_name(),
    ] {
        let hits = offenders(&code, &forbidden);
        assert!(
            hits.is_empty(),
            "`{forbidden}` appears in crate CODE at {hits:?} — the crate reads no \
             desktop config file; the five fields arrive through the packaged \
             `StartEnv` and the `config-update` push (T3)"
        );
    }
}

/// The master roadmap's decoupling criterion, as the S4 gate demands: "the crate
/// contains no tauri reference — make this a test, not a hope".
///
/// Matches the name as a TOKEN (a path segment, a type, an attribute) rather than a
/// substring, and ignores string literals for the single directory-name reason in
/// the module docs.
#[test]
fn no_code_names_the_desktop_ui_framework() {
    let code = crate_code();
    let forbidden = ui_framework_name();
    let is_a_hit = |body: &str| {
        strip_string_literals(body)
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .any(|tok| {
                tok.eq_ignore_ascii_case(&forbidden) || tok.starts_with(&format!("{forbidden}_"))
            })
    };
    let hits: Vec<(PathBuf, String)> = code
        .iter()
        .filter(|(_, body)| is_a_hit(body))
        .map(|(path, body)| {
            let shown = strip_string_literals(body)
                .lines()
                .find(|l| is_a_hit(l))
                .unwrap_or("(the token spans lines)")
                .trim()
                .to_string();
            (path.clone(), shown)
        })
        .collect();
    assert!(
        hits.is_empty(),
        "the desktop UI framework is named in crate CODE at {hits:?}"
    );
}

/// The same criterion for the other two things the crate must be free of: the
/// SQLite driver and the desktop package.
#[test]
fn no_code_names_the_sqlite_driver_or_the_desktop_package() {
    let code = crate_code();
    for forbidden in [sqlite_driver_name(), desktop_package_name()] {
        let hits = offenders(&code, &forbidden);
        assert!(
            hits.is_empty(),
            "`{forbidden}` appears in crate CODE at {hits:?}"
        );
    }
}

/// The manifest half, which no source grep can see: a dependency line is a harder
/// fact than an identifier, and any of the three could arrive with ZERO source
/// changes. This is also the pin that closes the string-literal blind spot above.
#[test]
fn the_manifest_declares_no_forbidden_dependency() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let text = std::fs::read_to_string(&manifest).expect("the crate has a manifest");
    for forbidden in [
        sqlite_driver_name(),
        desktop_package_name(),
        ui_framework_name(),
    ] {
        let offender = text
            .lines()
            .map(str::trim)
            .filter(|l| !l.starts_with('#'))
            .find(|l| {
                l.split_once('=')
                    .map(|(name, _)| {
                        let name = name.trim();
                        name == forbidden || name.starts_with(&format!("{forbidden}_plugin"))
                    })
                    .unwrap_or(false)
            });
        assert!(
            offender.is_none(),
            "`{forbidden}` is declared as a dependency ({offender:?}) — the crate \
             compiling without it IS the decoupling criterion"
        );
    }
}

/// The meta-pin: the needles must be the REAL identifiers, and the scan must FIRE.
///
/// This exists because the first draft assembled needles by joining parts with a
/// separator character, which made every needle unmatchable — all three source
/// scans then passed a deliberately planted settings read in a function body and
/// reported green. A guard whose needle cannot prick is worse than no guard,
/// because it is trusted. So: assert each assembled spelling equals the identifier
/// built from its raw characters, and assert [`offenders`] actually reports a
/// planted hit for each.
#[test]
fn the_needles_are_the_identifiers_they_stand_for() {
    let loader: String = [
        'l', 'o', 'a', 'd', '_', 's', 'e', 't', 't', 'i', 'n', 'g', 's',
    ]
    .iter()
    .collect();
    assert_eq!(settings_loader_name(), loader);
    let file: String = [
        's', 'e', 't', 't', 'i', 'n', 'g', 's', '.', 'j', 's', 'o', 'n',
    ]
    .iter()
    .collect();
    assert_eq!(settings_file_name(), file);
    let driver: String = ['r', 'u', 's', 'q', 'l', 'i', 't', 'e'].iter().collect();
    assert_eq!(sqlite_driver_name(), driver);
    let desktop: String = [
        'a', 'r', 'c', 'h', 'i', 'm', 'e', 'd', 'e', 's', '_', 'l', 'i', 'b',
    ]
    .iter()
    .collect();
    assert_eq!(desktop_package_name(), desktop);
    let ui: String = ['t', 'a', 'u', 'r', 'i'].iter().collect();
    assert_eq!(ui_framework_name(), ui);

    // And the scan FIRES on planted code. Without this, a needle that matches
    // nothing is indistinguishable from a clean crate.
    for forbidden in [
        loader.as_str(),
        file.as_str(),
        driver.as_str(),
        desktop.as_str(),
    ] {
        let planted = vec![(
            PathBuf::from("planted.rs"),
            format!("fn f() {{ let _ = {forbidden}; }}"),
        )];
        assert_eq!(
            offenders(&planted, forbidden).len(),
            1,
            "the scan did not fire on a planted `{forbidden}` — it is matching nothing"
        );
    }

    // The UI-framework scan uses the token matcher, so it gets its own firing test.
    let planted_ui = strip_string_literals(&format!("fn f() {{ {ui}::run(); }}"));
    assert!(
        planted_ui
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .any(|tok| tok.eq_ignore_ascii_case(&ui)),
        "the token matcher did not fire on a real path segment: {planted_ui}"
    );
}

/// The vacuity guards for the two strippers.
///
/// Every pin here asserts an ABSENCE, so all of them pass on empty input, and both
/// strippers could over-eat and silently blank the very code the pins hunt. So:
/// feed each one code it must preserve and prose it must remove, and require both.
#[test]
fn prose_is_stripped_but_code_is_not() {
    let (loader, ui, driver) = (
        settings_loader_name(),
        ui_framework_name(),
        sqlite_driver_name(),
    );
    let sample = format!(
        "//! This module explains why {loader} and {ui} stayed desktop.\n\
         // A line comment naming {driver} and the other forbidden crate.\n\
         /* a block comment naming the settings file too */\n\
         pub fn reads() -> u32 {{\n    \
         let _ = {loader}();\n    \
         let _ = {ui}::noop();\n    \
         let _ = {driver}::open();\n    \
         0\n}}\n"
    );
    let stripped = strip_comments(&sample);
    assert!(
        !stripped.contains("stayed desktop"),
        "doc prose should be stripped, got:\n{stripped}"
    );
    for forbidden in [&loader, &ui, &driver] {
        assert!(
            stripped.contains(forbidden.as_str()),
            "the comment-stripper swallowed `{forbidden}` out of a real statement — \
             the pins would then pass vacuously. Stripped:\n{stripped}"
        );
    }

    // The literal-stripper: it must blank a directory literal WITHOUT blanking an
    // adjacent real path segment, or the UI-framework pin is blind.
    let dir_name = format!("src-{ui}");
    let with_path = format!("let root = dir.join(\"{dir_name}\").join(\"src\"); {ui}::run();");
    let literals_gone = strip_string_literals(&with_path);
    assert!(
        !literals_gone.contains(&dir_name),
        "the directory literal should be blanked, got {literals_gone}"
    );
    assert!(
        literals_gone.contains(&format!("{ui}::run")),
        "a real path segment must SURVIVE literal-stripping or the pin is blind, got {literals_gone}"
    );
}
