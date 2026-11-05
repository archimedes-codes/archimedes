//! The ONE External-open policy (ADR 0051).
//!
//! An **External open** hands a URL or a filesystem path to the operating
//! system's own default handler. Four places in the Client used to try it and
//! each failed differently (a markdown anchor navigating the app's own webview,
//! a `target="_blank"` link wry silently denies, an `openPath` call the
//! capability never granted, and a hand-rolled per-OS
//! `open`/`cmd /c start`/`xdg-open`). This module is what all of them call
//! instead: classification (URL vs path), the scheme policy, and the path join.
//!
//! It is deliberately NOT behind the Tauri ACL. The plugin's IPC commands
//! consult its scope; its Rust free functions (`open_url` / `open_path`) do
//! not, so this seam needs no capability entry and `capabilities/default.json`
//! stays untouched (ADR 0051). That means a bug here has nothing behind it —
//! hence the second layer, the `on_navigation` guard, and hence the tests below
//! covering every row of the decision table rather than the happy path only.
//!
//! The scheme policy is a DENYLIST, not an allow-list: the OS is the thing that
//! knows what a scheme means, so `slack://`, `ssh://` and `file://` reach it,
//! and the click is the user's consent.
//!
//! No IPC and no UI here — `classify` is pure (no IO, no `home_dir` env read
//! beyond [`skills::home_dir`]), so the whole policy is unit-testable.

use std::path::{Path, PathBuf};
use tauri::Url;

/// Schemes refused outright. Everything NOT listed reaches the OS, because the OS
/// owns what a scheme means (ADR 0051). Compared LOWERCASE — `Url::scheme()`
/// lowercases, and the denylist check happens after parsing for exactly that
/// reason (so `JavaScript:` is caught too).
const DENIED_SCHEMES: [&str; 5] = ["javascript", "data", "vbscript", "blob", "filesystem"];

/// Opaque (no `//authority`) schemes that are still URLs. Without this list a
/// file named `notes:2024.md` parses as scheme `notes` and would go to the OS as
/// a URL instead of opening as a path.
const OPAQUE_SCHEMES: [&str; 5] = ["mailto", "tel", "sms", "urn", "xmpp"];

/// What [`classify`] decided the href is. Both derives are LOAD-BEARING: the
/// tests assert with `assert_eq!`.
#[derive(Debug, PartialEq)]
pub enum Target {
    /// Hand this string to the OS's URL handler, verbatim.
    Url(String),
    /// Hand this path to the OS's file/folder handler. Never canonicalised —
    /// `open_path` resolves it, and an existence check here would only race it.
    Path(PathBuf),
}

/// Why [`classify`] refused to open anything.
#[derive(Debug, PartialEq)]
pub enum Refusal {
    /// empty / whitespace-only href
    Empty,
    /// a `DENIED_SCHEMES` scheme, with the scheme name
    DeniedScheme(String),
    /// a `file:` URL this platform cannot turn into a path (incl. a non-localhost host)
    BadFileUrl(String),
    /// a relative path with no cwd to resolve it against
    RelativeWithoutCwd,
}

impl Refusal {
    /// The stable wire code the renderer logs (`denied-scheme:javascript`).
    pub fn code(&self) -> String {
        match self {
            Refusal::Empty => "empty".to_string(),
            Refusal::DeniedScheme(scheme) => format!("denied-scheme:{scheme}"),
            Refusal::BadFileUrl(href) => format!("bad-file-url:{href}"),
            Refusal::RelativeWithoutCwd => "relative-without-cwd".to_string(),
        }
    }
}

/// A Windows drive root (`C:/…` or `C:\…`). Checked BEFORE `Url::parse`,
/// because `Url::parse("C:/dir/f")` SUCCEEDS and yields the scheme `c` — a
/// single ASCII letter is a legal RFC 3986 scheme. Anything that reaches the
/// parser first would send `C:/dir/f` to the OS as a URL.
fn is_drive_root(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\')
}

/// A UNC share (`\\server\share`).
fn is_unc(s: &str) -> bool {
    s.starts_with("\\\\")
}

/// The path route: fragment/query stripped, then absolute / tilde-expanded /
/// joined onto `cwd`. NOT canonicalised and NOT checked against the _Boundary_
/// — the _Boundary_ confines the **Agent**, never the user's own click.
///
/// The `#`/`?` strip is here rather than in `classify` because BOTH routes that
/// land on a path need it: an unparseable href (`README.md#L42`) and a
/// scheme-shaped one that turned out to be a filename (`notes:2024.md`). The
/// Client has no editor, so a line number cannot be honoured — the FILE opens.
fn path_target(s: &str, cwd: Option<&Path>) -> Result<Target, Refusal> {
    // Everything from the FIRST `#` or `?` is a fragment/query, never part of
    // the filename. `split` always yields a first item.
    let s = s.split(['#', '?']).next().unwrap_or("").trim();
    if s.is_empty() {
        return Err(Refusal::Empty);
    }
    if s.starts_with('/') || is_drive_root(s) || is_unc(s) {
        return Ok(Target::Path(PathBuf::from(s)));
    }
    // The ONE place in the app that expands a tilde (ADR 0051).
    if s == "~" || s.starts_with("~/") {
        let rest = if s == "~" { "" } else { &s[2..] };
        return match crate::skills::home_dir() {
            Some(home) if rest.is_empty() => Ok(Target::Path(home)),
            Some(home) => Ok(Target::Path(home.join(rest))),
            // No home at all: the remainder is just a relative path, so it is
            // refused when there is no cwd — the same contract as any relative.
            None => join_relative(rest, cwd),
        };
    }
    join_relative(s, cwd)
}

/// The last arm of [`path_target`]. `PathBuf::join`, NEVER string
/// concatenation — a Windows path join is not a `/`. That is the whole reason
/// this policy is in Rust rather than in the renderer.
fn join_relative(rel: &str, cwd: Option<&Path>) -> Result<Target, Refusal> {
    match cwd {
        Some(cwd) => Ok(Target::Path(cwd.join(rel))),
        None => Err(Refusal::RelativeWithoutCwd),
    }
}

/// Decide what an href means, WITHOUT opening it and WITHOUT any IO.
///
/// The ORDER below is load-bearing, so it is numbered rather than left to the
/// reader:
///
/// 1. Normalise: drop every `\t`, `\n` and `\r`, then trim. Markdown can spell
///    `javascript:` as `java&#10;script:`, and this is the ONLY place that gets
///    closed — a parser that sees `java\nscript:` does not see a scheme at all.
/// 2. Empty → refuse.
/// 3. The shapes that a URL parser would MISTRIBUTE, checked before it runs:
///    a Windows drive root (`Url::parse("C:/dir/f")` SUCCEEDS as scheme `c`,
///    because a single ASCII letter is a legal RFC 3986 scheme — the single
///    most likely bug in this module), a UNC share, a tilde, and the schemeless
///    `www.` form GFM would have prefixed for an autolink literal but NOT for an
///    explicit `[w](www.example.com/x)`.
/// 4. `Url::parse`.
/// 5. On `Ok`: the denylist, then `file:`, then the scheme-shaped-but-meant-as-
///    a-path guard, then "it is a URL".
/// 6. On `Err`, and on that guard: [`path_target`].
pub fn classify(href: &str, cwd: Option<&Path>) -> Result<Target, Refusal> {
    // 1.
    let s: String = href
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let s = s.trim();
    // 2.
    if s.is_empty() {
        return Err(Refusal::Empty);
    }
    // 3. The shapes `Url::parse` would misroute, caught before it runs.
    if is_drive_root(s) || is_unc(s) || s == "~" || s.starts_with("~/") {
        return path_target(s, cwd);
    }
    if s.starts_with("www.") {
        return Ok(Target::Url(format!("http://{s}")));
    }
    // 4.
    match Url::parse(s) {
        // 5.
        Ok(url) => {
            // `Url::scheme()` is already lowercased, which is what lets the
            // denylist be five lowercase names and still catch `JavaScript:`.
            let scheme = url.scheme();
            if DENIED_SCHEMES.contains(&scheme) {
                return Err(Refusal::DeniedScheme(scheme.to_string()));
            }
            if scheme == "file" {
                // The host is checked HERE, on purpose: `to_file_path()` is
                // platform-split about hosts, and its Windows branch turns
                // `file://otherhost/x` into the UNC path `\\otherhost\x`
                // instead of erroring. A click must not reach another machine.
                return match url.host_str() {
                    None | Some("") | Some("localhost") => url
                        .to_file_path()
                        .map(Target::Path)
                        .map_err(|_| Refusal::BadFileUrl(s.to_string())),
                    _ => Err(Refusal::BadFileUrl(s.to_string())),
                };
            }
            // Scheme-shaped, but meant as a path: `notes:2024.md` PARSES as
            // scheme `notes`, and a file by that name is far likelier than a
            // registered `notes:` handler. `OPAQUE_SCHEMES` is what keeps the
            // opaque forms that ARE URLs (`mailto:`, `tel:`) URLs.
            if !url.has_authority() && !OPAQUE_SCHEMES.contains(&scheme) {
                return path_target(s, cwd);
            }
            // The NORMALISED ORIGINAL, never `url.as_str()`: the URL parser
            // re-encodes what the user meant (a `%20` becomes `%2520` on the
            // way through some schemes), and the OS is the decoder here.
            Ok(Target::Url(s.to_string()))
        }
        // 6.
        Err(_) => path_target(s, cwd),
    }
}

/// [`classify`], then the plugin's Rust free functions (which bypass the ACL
/// scope, by design — see the module docs).
///
/// No existence check: `open_path` `metadata()`-checks the path and errors on a
/// missing one, so checking here would only race it and duplicate its error.
pub fn open(href: &str, cwd: Option<&Path>) -> Result<(), String> {
    // No `?` on the refusal: its wire form is `Refusal::code()`, not a Display.
    match classify(href, cwd) {
        Err(r) => Err(r.code()),
        Ok(Target::Url(u)) => {
            tauri_plugin_opener::open_url(&u, None::<&str>).map_err(|e| format!("os-error:{e}"))
        }
        Ok(Target::Path(p)) => {
            tauri_plugin_opener::open_path(&p, None::<&str>).map_err(|e| format!("os-error:{e}"))
        }
    }
}

/// The desktop's implementation of the crate's `fulcrum_core::mcp::OpenRequester`
/// (T5/S3, edge E6).
///
/// # Why this type is here and the trait is in the crate
///
/// `mcp/manager.rs` moved to `fulcrum-core` in T5/S3 and this file did not: the
/// plugin call below is `tauri`, and the crate compiling with no `tauri` in its
/// graph is the master roadmap's own decoupling criterion. So the crate declares
/// the need and the desktop satisfies it — the allowed direction, and the same
/// shape as T3's `IpcRenderRequester` for `web::RenderRequester`.
///
/// # Why it is a unit struct over [`open`] and nothing more
///
/// Behaviour-identical by construction: the pre-seam MCP call site was
/// `let _ = crate::open::open(url, None)` — the ONE External-open policy, with
/// the scheme denylist, the drive-root/UNC guards and the `~` expansion all of
/// which stay here. The MCP OAuth flow ignores the `Result` exactly as it did
/// before (fire-and-forget; the authorization URL is in the OAuth error text).
/// `cwd: None` is preserved verbatim: an OAuth authorization URL is absolute, and
/// passing a cwd would give a relative href a resolution context the flow never
/// had.
pub struct DesktopOpenRequester;

impl crate::agent::mcp::OpenRequester for DesktopOpenRequester {
    fn open(&self, url: &str) -> Result<(), String> {
        open(url, None)
    }
}

/// The shared handle the MCP wiring passes around (a unit struct, so one
/// allocation is all there is — and every site could equally construct its own).
pub fn desktop_open_requester() -> std::sync::Arc<dyn crate::agent::mcp::OpenRequester> {
    std::sync::Arc::new(DesktopOpenRequester)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// The cwd every relative-path row resolves against.
    const CWD: &str = "/home/u/proj";

    // `every_desktop_mcp_manager_carries_the_open_requester` MOVED into the engine
    // crate in T8b/S8b.4, as
    // `fulcrum_core::source_lints::every_crate_mcp_manager_carries_the_open_requester`.
    //
    // It read `../crates/fulcrum-core/src/harness/loop.rs` by PATH and asserted
    // nothing about the DESKTOP — only that this crate's two `McpManager::new(`
    // sites each reach `.with_open_requester(` before their `;`. That is a claim
    // about the crate's own construction sites, so it belongs in the crate; and it
    // had to, because after T8b the desktop consumes the engine as a GIT
    // dependency, whose cargo checkout lands under
    // `~/.cargo/git/checkouts/<name>-<hash>/<rev>/` and therefore has NO stable
    // path this file could name. Deleting it here without moving it would have been
    // the silent half of the split: no compile error, no red test, one less
    // guarantee.
    //
    // ⚠ This file's `use std::path::Path` is NOT now dead — `classify` and the
    // `url`/`path` helpers below take `&Path`. The compiler, not this note, is the
    // proof.

    // `the_production_loop_caller_passes_the_desktop_opener` below was SPLIT, not
    // moved: it read TWO trees — the crate's `worker/core.rs` (structure) and the
    // desktop's `lib.rs` (the needle). Its crate half is now
    // `fulcrum_core::source_lints::the_crate_threads_the_opener_into_its_production_loop`;
    // what stays here is the DESKTOP needle, which the crate must never be able to
    // read (desktop → crate is the legal direction; the reverse is the crossing the
    // whole boundary exists to prevent).

    /// (T5/S5a SEAM 2, SPLIT by T8b/S8b.4) The DESKTOP half of the opener wiring:
    /// the DESKTOP'S CALL SITE must hand the loop the real opener.
    ///
    /// # What this test is now, and what moved out of it
    ///
    /// Until S8b/S8b.4 this read TWO trees: the engine's `worker/core.rs` (the
    /// STRUCTURE — one production `#[cfg(test)]` split, one production
    /// `AgentLoop::new(`, `default_build_loop` takes the opener, that call passes it,
    /// production constructs no opener) and the desktop's `lib.rs` (the NEEDLE).
    /// The structure half is now
    /// `fulcrum_core::source_lints::the_crate_threads_the_opener_into_its_production_loop`,
    /// because a desktop-side `../crates/fulcrum-core/...` read cannot survive the
    /// engine becoming a GIT dependency (a cargo git checkout has no stable path).
    /// The needle stays HERE, and it could not have gone the other way: asserting
    /// that the desktop passes `crate::open::desktop_open_requester()` requires
    /// naming a desktop module, and the crate may never do that
    /// (`no_path_reaches_a_desktop_module`).
    ///
    /// Neither half alone proves the chain. Together they reach the same conclusion
    /// the single pre-split lint did: the production loop carries an opener the
    /// crate did not invent, and the desktop hands in the real one. Each side has
    /// its own vacuity guards, so a side that reads nothing cannot pass.
    ///
    /// # Why the seam needs a lint at all
    ///
    /// Until S5a, `AgentLoop::new` and `set_desktop_config` each called
    /// `crate::open::desktop_open_requester()` THEMSELVES. That is the desktop's own
    /// module reaching its own `open.rs`, so it compiled — and it was the bug the S5
    /// RULING names: `open.rs` is `tauri` and cannot follow `harness` into the
    /// crate. So the loop now TAKES the opener as a required argument and the
    /// desktop's one production caller supplies it.
    ///
    /// Making that parameter required already turns FORGETTING it into a compile
    /// error (`E0061`), which is the main answer to "is forgetting the opener at the
    /// desktop call site caught, or silently defaulted?" — it is caught, and
    /// `AgentLoop` has no `Default` and no builder that could fill it in. But a
    /// caller CAN still pass `Arc::new(NoOpenRequester)` and compile: the type is
    /// the same and the default is a legitimate value for a test. That is the silent
    /// failure this lint closes, and the crate-side half closes it one level down.
    /// Both read CODE with comment lines dropped — a doc comment naming
    /// `desktop_open_requester` must not credit a call site that never makes it, the
    /// same fail-OPEN direction this file's other scans refuse.
    ///
    /// # Why the scan is SCOPED to `run_worker`'s own body
    ///
    /// Since S8.4 the site is `src-tauri/src/lib.rs::run_worker`, which must pass
    /// `crate::open::desktop_open_requester()` to `fulcrum_core::worker::run_worker(…)`
    /// — exactly once. S8.2's needle lived on the `agent/worker/mod.rs` wrapper;
    /// S8.4 DELETED that wrapper, so the needle moved with the call site — pointing
    /// at a file that no longer holds it would be the unfalsifiable-needle failure
    /// this plan's review round rejected. This scan therefore also asserts the
    /// ABSENCE of `agent::worker::run_worker_inner(` in `lib.rs`: a restored wrapper
    /// would satisfy a bare `contains` on the opener and still break the chain. And
    /// `lib.rs` is a ~1,600-line file with many other call sites, so a file-wide
    /// `contains` is trivially satisfiable — S8.2's child measured exactly that
    /// vacuity in its own first draft.
    ///
    /// # Non-vacuity (measured on this half)
    ///
    /// Replace `crate::open::desktop_open_requester(),` in `lib.rs::run_worker` with
    /// a placeholder opener (`std::sync::Arc::new(fulcrum_core::mcp::NoOpenRequester),`)
    /// → this fails naming the call site, while the workspace still compiles green —
    /// which is precisely why the lint is worth having. Re-proved for S8b/S8b.4 (see
    /// the run's report); the crate-side half's parameter assert is proved there too.
    #[test]
    fn the_production_loop_caller_passes_the_desktop_opener() {
        // ── The NEEDLE, at the DESKTOP'S ONE hand-off ────────────────────────
        // (T8/S8.4) Since the S8.2 wrapper in `agent/worker/mod.rs` is deleted,
        // `src-tauri/src/lib.rs::run_worker` is the ONE desktop site that
        // supplies the opener to the crate — the whole point of the boundary
        // (desktop → crate is legal; the reverse is the crossing). So the needle
        // lives here now, and `lib.rs` is its only home.
        let shim = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs");
        let shim_source = std::fs::read_to_string(&shim)
            .unwrap_or_else(|e| panic!("reading {}: {e}", shim.display()));
        let shim_source = shim_source.replace("\r\n", "\n");
        let shim_code: Vec<(usize, &str)> = shim_source
            .lines()
            .enumerate()
            .map(|(i, l)| (i + 1, l))
            // CODE, not prose — the same fail-OPEN reason as half 1. `lib.rs`
            // names `desktop_open_requester` in THIS function's doc comment; a
            // scan that read it would credit a shim that never passes it.
            .filter(|(_, l)| {
                let t = l.trim_start();
                !t.starts_with("//")
            })
            .collect();

        // SCOPED TO `run_worker`'S OWN BODY. `lib.rs` is a large file with many
        // other call sites; a file-wide `contains` would be trivially
        // satisfiable, and a needle that cannot fail is not a pin. The body runs
        // from the `pub fn run_worker() {` line to the first line that is just
        // `}` at fn-body indentation.
        let fn_line = shim_code
            .iter()
            .find(|(_, l)| l.trim_start().starts_with("pub fn run_worker("))
            .map(|(n, _)| *n)
            .unwrap_or_else(|| panic!("no `pub fn run_worker(` in {shim:?}"));
        let fn_end = shim_code
            .iter()
            .find(|(n, l)| *n > fn_line && *l == "}")
            .map(|(n, _)| *n)
            .unwrap_or_else(|| panic!("no closing `}}` for run_worker at {fn_line} in {shim:?}"));
        let body = shim_code
            .iter()
            .filter(|(n, _)| *n > fn_line && *n < fn_end)
            .map(|(n, l)| (*n, *l))
            .collect::<Vec<_>>();

        let call_lines: Vec<usize> = body
            .iter()
            .filter(|(_, l)| l.contains("fulcrum_core::worker::run_worker("))
            .map(|(n, _)| *n)
            .collect();
        assert_eq!(
            call_lines.len(),
            1,
            "expected exactly 1 call to `fulcrum_core::worker::run_worker(` inside \
             `lib.rs::run_worker` ({fn_line}..{fn_end}) (the S8.4 shim — the ONE \
             desktop site that supplies the opener), found {call_lines:?}: a second \
             one would be an unwired worker entry this lint does not read, and zero \
             means the desktop still reaches a wrapper the crate no longer exposes",
        );
        // The desktop must NOT keep a wrapper of its own: `agent/worker/mod.rs`
        // is a pure re-export shell since S8.4, so a `run_worker_inner(` spelling
        // in `lib.rs` would mean the hand-off moved back out of `run_worker`'s
        // body and this needle is reading the wrong function.
        let wrapper = shim_code
            .iter()
            .find(|(_, l)| l.contains("agent::worker::run_worker_inner("))
            .map(|(n, l)| (*n, l.trim().to_string()));
        assert!(
            wrapper.is_none(),
            "`lib.rs` still calls the desktop `agent::worker::run_worker_inner(` at \
             {wrapper:?} — S8.4 deleted that wrapper (the shell is pure re-exports), \
             and if it were restored the opener would be supplied OUTSIDE the \
             function this needle reads, so this pin would be pointing at the wrong \
             call site",
        );
        let call = call_lines[0];
        // The argument list runs to the first line that is just `);`.
        let end = body
            .iter()
            .find(|(n, l)| *n > call && l.trim() == ");")
            .map(|(n, _)| *n)
            .unwrap_or_else(|| panic!("no closing `);` found for the shim call at {call}"));
        let passed: Vec<usize> = body
            .iter()
            .filter(|(n, l)| {
                *n > call && *n < end && l.contains("crate::open::desktop_open_requester()")
            })
            .map(|(n, _)| *n)
            .collect();
        assert_eq!(
            passed.len(),
            1,
            "the desktop shim at {shim:?}:{call} (`run_worker`) does not pass \
             `crate::open::desktop_open_requester()` to the crate exactly once \
             (found {passed:?}) — the Worker's loop would then carry \
             `NoOpenRequester` for every session, so the MCP `auth` action would \
             silently never open a browser and its OAuth flow would die at the \
             callback timeout",
        );
        // The SECOND injected seam, so the shim is pinned as a whole and not
        // half-restored: the crash hook is the other desktop thing the crate may
        // not name (`agent/crashlog.rs` stayed desktop).
        let hook_lines: Vec<usize> = body
            .iter()
            .filter(|(n, l)| *n > call && *n < end && l.contains("install_panic_hook(\"worker\""))
            .map(|(n, _)| *n)
            .collect();
        assert_eq!(
            hook_lines.len(),
            1,
            "the desktop shim at {shim:?}:{call} (`run_worker`) does not pass the \
             `install_panic_hook(\"worker\", …)` closure exactly once (found \
             {hook_lines:?}) — a Worker that panics with no hook leaves no crash \
             log, which is the whole reason the hook exists",
        );
    }

    // `the_harness_takes_the_opener_instead_of_constructing_it` MOVED into the
    // engine crate in T8b/S8b.4, as
    // `fulcrum_core::source_lints::the_harness_takes_the_opener_instead_of_constructing_it`.
    //
    // It read `../crates/fulcrum-core/src/harness/loop.rs` and asserted an ABSENCE
    // (`crate::open::` appears nowhere in that module) plus a PRESENCE (the
    // constructor takes the opener; the rebuild re-uses the stored one). Both
    // claims are about the crate, and after T8b no path from here can name that
    // file — a git dependency's cargo checkout has no stable location.
    //
    // The crate-side copy is STRONGER than the desktop one was, not just relocated:
    // the crate can assert the absence of `crate::open::` over its OWN whole tree
    // via `boundary_pins::no_path_reaches_a_desktop_module`, which is the pin that
    // makes this module's half a special case of a general rule rather than a
    // one-file grep. Its non-vacuity (restore the construction → red on the absence
    // half; delete the parameter → red on the presence half) is re-proved crate-side
    // in this task's run.

    fn url(s: &str) -> Target {
        Target::Url(s.to_string())
    }

    fn path(s: &str) -> Target {
        Target::Path(PathBuf::from(s))
    }

    type Row = (&'static str, Option<&'static str>, Result<Target, Refusal>);

    fn check(rows: &[Row]) {
        for (href, cwd, expected) in rows {
            assert_eq!(
                classify(href, cwd.map(Path::new)),
                *expected,
                "classify({href:?}, {cwd:?})"
            );
        }
    }

    /// The denylist is a denylist: any scheme the OS knows about passes.
    #[test]
    fn classify_sends_every_unlisted_scheme_to_the_os_as_a_url() {
        check(&[
            (
                "https://example.com/x",
                None,
                Ok(url("https://example.com/x")),
            ),
            ("slack://chan/x", None, Ok(url("slack://chan/x"))),
            ("ssh://host", None, Ok(url("ssh://host"))),
            ("ftp://h/f", None, Ok(url("ftp://h/f"))),
        ]);
    }

    /// The five refused schemes, plus the tab/LF/CR spelling markdown allows
    /// inside a scheme — normalising is the ONLY place that gets closed.
    #[test]
    fn classify_refuses_the_denied_schemes_including_a_newline_spelling() {
        check(&[
            (
                "javascript:alert(1)",
                None,
                Err(Refusal::DeniedScheme("javascript".to_string())),
            ),
            (
                "java\nscript:alert(1)",
                None,
                Err(Refusal::DeniedScheme("javascript".to_string())),
            ),
            (
                "data:text/html,x",
                None,
                Err(Refusal::DeniedScheme("data".to_string())),
            ),
            (
                "vbscript:x",
                None,
                Err(Refusal::DeniedScheme("vbscript".to_string())),
            ),
            (
                "blob:https://a/b",
                None,
                Err(Refusal::DeniedScheme("blob".to_string())),
            ),
            (
                "filesystem:http://a/b",
                None,
                Err(Refusal::DeniedScheme("filesystem".to_string())),
            ),
        ]);
    }

    /// Paths stay paths. `C:/dir/f` is the load-bearing row: `Url::parse`
    /// ACCEPTS it as scheme `c`, so it is only a path if the drive root is
    /// detected before the parser runs. `classify` never canonicalises, so the
    /// Windows spellings assert the literal `PathBuf` on every platform.
    #[test]
    fn classify_routes_paths_and_never_canonicalises_them() {
        check(&[
            ("C:/dir/f", None, Ok(path("C:/dir/f"))),
            ("C:\\dir\\f", None, Ok(path("C:\\dir\\f"))),
            ("/abs/x", None, Ok(path("/abs/x"))),
            ("\\\\server\\share", None, Ok(path("\\\\server\\share"))),
            (
                "src/main.rs",
                Some(CWD),
                Ok(path("/home/u/proj/src/main.rs")),
            ),
            // No editor in the Client, so a line number cannot be honoured —
            // the fragment/query is dropped and the FILE opens.
            (
                "README.md#L42",
                Some(CWD),
                Ok(path("/home/u/proj/README.md")),
            ),
            (
                "README.md?x=1",
                Some(CWD),
                Ok(path("/home/u/proj/README.md")),
            ),
            // `notes:2024.md` PARSES as scheme `notes`; a file by that name is
            // far likelier than a registered handler, so it is a path.
            (
                "notes:2024.md",
                Some(CWD),
                Ok(path("/home/u/proj/notes:2024.md")),
            ),
        ]);
    }

    /// A relative path with no cwd to resolve it against is refused — there is
    /// nothing sensible to join it onto (and `home_dir` is NOT a fallback).
    #[test]
    fn classify_refuses_a_relative_path_with_no_cwd() {
        check(&[("src/main.rs", None, Err(Refusal::RelativeWithoutCwd))]);
    }

    #[test]
    fn classify_refuses_an_empty_href() {
        check(&[
            ("", None, Err(Refusal::Empty)),
            ("   ", None, Err(Refusal::Empty)),
        ]);
    }

    /// GFM's `www.` → `http://www.…` prefixing applies only to *autolink
    /// literals*, so an explicit `[w](www.example.com/x)` reaches this policy
    /// schemeless; without this row it would be joined onto the cwd as a path.
    #[test]
    fn classify_prefixes_a_www_href_with_http() {
        check(&[(
            "www.example.com/x",
            Some(CWD),
            Ok(url("http://www.example.com/x")),
        )]);
    }

    /// Opaque schemes that ARE URLs (the list is what keeps them URLs when
    /// `notes:` is not).
    #[test]
    fn classify_keeps_opaque_scheme_urls_as_urls() {
        check(&[
            ("mailto:a@b.c", None, Ok(url("mailto:a@b.c"))),
            ("tel:+15551234", None, Ok(url("tel:+15551234"))),
        ]);
    }

    /// `Url::to_file_path()` is platform-split about hosts: on Windows
    /// `file://otherhost/x` becomes the UNC path `\\otherhost\x` instead of
    /// erroring. So the host is checked HERE, before it.
    #[test]
    fn classify_refuses_a_file_url_for_a_foreign_host() {
        check(&[(
            "file://otherhost/x",
            None,
            Err(Refusal::BadFileUrl("file://otherhost/x".to_string())),
        )]);
    }

    /// `to_file_path()` percent-decodes and drops the `#fragment`, so
    /// `file:///tmp/a%20b.md#L3` is the path `/tmp/a b.md`. GATED: the Windows
    /// branch of `to_file_path` requires a drive-letter first segment, so an
    /// ungated `/tmp` row would redden `cargo test` for a Windows contributor.
    #[cfg(unix)]
    #[test]
    fn classify_turns_a_local_file_url_into_a_percent_decoded_path() {
        check(&[("file:///tmp/a%20b.md#L3", None, Ok(path("/tmp/a b.md")))]);
    }

    /// The Windows twin of the row above.
    #[cfg(windows)]
    #[test]
    fn classify_turns_a_local_file_url_into_a_percent_decoded_path() {
        check(&[("file:///C:/dir/f%20g", None, Ok(path("C:\\dir\\f g")))]);
    }

    /// Restores `HOME` on scope exit (even when an assertion panics
    /// mid-test): `Some(v)` → set, `None` → remove. The crate-wide guard for
    /// mutating process env in the lib test binary — see
    /// `commands/agents.rs`'s identical private helper.
    struct RestoreHome(Option<std::ffi::OsString>);
    impl Drop for RestoreHome {
        fn drop(&mut self) {
            match self.0.take() {
                // SAFETY: the `ENV_LOCK` is still held at drop time (this
                // guard is declared after the `_lock` guard and outlives
                // it in reverse); no other thread mutates HOME concurrently.
                Some(v) => unsafe {
                    std::env::set_var("HOME", v);
                },
                // SAFETY: same as above.
                None => unsafe {
                    std::env::remove_var("HOME");
                },
            }
        }
    }

    /// The tilde row is its OWN test, not a table row: `skills::home_dir()`
    /// reads `HOME`, and `cargo test` runs these tests as threads of ONE
    /// process — so it takes `env_lock()` + `RestoreHome` like every other
    /// HOME-mutating test in this crate.
    #[test]
    fn classify_expands_a_leading_tilde_with_home_dir() {
        let _lock = crate::test_support::env_lock();
        let original = std::env::var_os("HOME");
        let _restore = RestoreHome(original.clone());
        // SAFETY: the `ENV_LOCK` is held for the whole set→assert→restore span;
        // no other thread mutates HOME concurrently.
        unsafe {
            std::env::set_var("HOME", "/home/u");
        }
        check(&[
            ("~/notes.md", None, Ok(path("/home/u/notes.md"))),
            ("~/notes.md", Some(CWD), Ok(path("/home/u/notes.md"))),
            ("~", None, Ok(path("/home/u"))),
            ("~/notes.md#L3", None, Ok(path("/home/u/notes.md"))),
        ]);
    }

    /// The wire codes are a contract with the renderer (Task 2 logs them), so
    /// they are pinned here rather than left to the `Display` of the day.
    #[test]
    fn refusal_codes_are_stable_wire_strings() {
        assert_eq!(Refusal::Empty.code(), "empty");
        assert_eq!(
            Refusal::DeniedScheme("javascript".to_string()).code(),
            "denied-scheme:javascript"
        );
        assert_eq!(
            Refusal::BadFileUrl("file://otherhost/x".to_string()).code(),
            "bad-file-url:file://otherhost/x"
        );
        assert_eq!(Refusal::RelativeWithoutCwd.code(), "relative-without-cwd");
    }

    /// A refusal never reaches the OS — this is the ONLY affordable test for
    /// `open`, since a successful one launches whatever the machine has
    /// registered (`capabilities`-free by design; the platform behaviour is
    /// verified by hand, not in CI).
    #[test]
    fn open_returns_the_refusal_code_without_touching_the_os() {
        assert_eq!(
            open("javascript:alert(1)", None),
            Err("denied-scheme:javascript".to_string())
        );
        assert_eq!(open("  ", None), Err("empty".to_string()));
        assert_eq!(
            open("src/main.rs", None),
            Err("relative-without-cwd".to_string())
        );
    }
}
