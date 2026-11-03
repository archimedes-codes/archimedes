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

    /// (T5/S3, edge E6) The desktop-side half of the `OpenRequester` wiring pin.
    ///
    /// # Why a source lint, and what the crate-side test cannot see
    ///
    /// `mcp::manager::tests::the_auth_action_opens_the_browser_through_the_seam`
    /// proves the manager CONSUMES the seam — it drives a real `authorization_code`
    /// flow and fails if the injected requester is never called. It cannot see
    /// whether the DESKTOP hands it a real opener, because the desktop's own
    /// construction sites are outside that crate. And the failure mode there is
    /// silent by design: `McpManager::new` defaults to `NoOpenRequester`, so a
    /// construction site that forgets the second builder step still connects,
    /// still lists tools, still reports `authenticated` — it just never opens a
    /// browser, and the OAuth flow dies at its callback timeout.
    ///
    /// So this is the same shape as the repo's other wiring lints
    /// (`harness/manager`'s `the_spawn_site_reports_through_the_shared_helper`,
    /// `window_state_plugin_is_registered…`): read the source, require the call,
    /// panic on an unreadable file so a moved file is RED rather than skipped.
    ///
    /// # The rule it enforces
    ///
    /// Every `McpManager::new(` in the desktop's `harness/loop.rs` must be
    /// followed by `.with_open_requester(` before its closing `;`. Both sites are
    /// required, and that is the point: `set_desktop_config` REPLACES the manager
    /// built by `new`, so wiring only the first one leaves the production loop —
    /// the one that actually runs with a packaged `mcpServers` map — on the
    /// no-op default.
    #[test]
    fn every_desktop_mcp_manager_carries_the_open_requester() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/agent/harness/loop.rs");
        let source = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
        // CRLF-normalised, for the reason `tests/provider_oauth_flow.rs::crate_source`
        // documents: a Windows checkout carries CRLF and a needle carrying a bare
        // `\n` matches nothing there, which is how a structural pin goes red on
        // `windows-latest` while green everywhere else.
        let source = source.replace("\r\n", "\n");

        // Scan CODE, not prose: the region is read line by line with comment
        // lines dropped, for two reasons. (1) A `;` inside a doc comment (this
        // very file's "it is `tauri`; this is one of the two sites") would end
        // the region early and credit a site that is not wired — the fail-OPEN
        // direction, which is the one this repo's whole census tradition refuses.
        // (2) A `.with_open_requester(` named in a comment would likewise pass a
        // site whose real code never calls it.
        let code: Vec<(usize, String)> = source
            .lines()
            .enumerate()
            .map(|(i, l)| (i + 1, l.to_string()))
            .filter(|(_, l)| !l.trim_start().starts_with("//"))
            .collect();

        let ctor_lines: Vec<usize> = code
            .iter()
            .filter(|(_, l)| l.contains("McpManager::new("))
            .map(|(n, _)| *n)
            .collect();
        assert_eq!(
            ctor_lines.len(),
            2,
            "expected exactly 2 `McpManager::new(` construction sites in \
             harness/loop.rs (`AgentLoop::new` + the `set_desktop_config` rebuild), \
             found {ctor_lines:?} — a different count means this lint's premise moved, so \
             either a site lost its wiring or a new one appeared that this lint does not read",
        );

        for (n, ctor_line) in ctor_lines.iter().enumerate() {
            // The region runs from the constructor to the next one (or EOF), so a
            // missing first wiring cannot be credited by the second site's call.
            let stop = ctor_lines.get(n + 1).copied().unwrap_or(usize::MAX);
            let wired: Vec<usize> = code
                .iter()
                .filter(|(line, text)| {
                    *line > *ctor_line && *line < stop && text.contains(".with_open_requester(")
                })
                .map(|(line, _)| *line)
                .collect();
            assert!(
                !wired.is_empty(),
                "construction site #{} (`McpManager::new(` at harness/loop.rs:{ctor_line}) \
                 never reaches `.with_open_requester(` — the manager would run on \
                 `NoOpenRequester`, so the MCP `auth` action would silently never open a \
                 browser and its OAuth flow would die at the callback timeout",
                n + 1
            );
        }
    }

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
