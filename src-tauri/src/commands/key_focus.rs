//! The key-focus cluster and the Worker-factory seam, moved out of `lib.rs`
//! (godfile decomposition, Task 4).
//!
//! Two things live here, and they share a home because both are the command
//! layer's own business rather than the app entry point's:
//!
//!   * the **key-focus** logic — the webview WIDGET (not the window) must hold
//!     key focus or no key event reaches JS (ADR 0056), and the `Focused(true)`
//!     re-assert must be withheld on Windows or clicking breaks (ADR 0061). The
//!     pure reductions (`focus_probe_trace`, `key_focus_grab_needed`,
//!     `webview_focus_trace`) are here so the platform matrix stays testable on
//!     Linux; `run_event_callback` in `lib.rs` remains the CALLER and keeps its
//!     `cfg!(windows)` data-passing, which is the whole point of that shape.
//!   * the **Worker factory** — `ProductionWorkerFactory` is the seam
//!     `commands/` already consumes (`agent/session/mod.rs` reaches it as
//!     `crate::ProductionWorkerFactory`, which `lib.rs` re-exports so that path
//!     keeps resolving).
//!
//! `lib.rs`'s inline `mod tests` stayed put and reaches these items through
//! `crate::commands::key_focus::…`.

use tauri::Manager;

use crate::agent::debuglog;
use crate::agent::worker::client::WorkerHandle;
use crate::agent::worker::manager::WorkerFactory;

/// The focus probe's raw answer, reduced to `(the boolean the countdown sees,
/// the line for the debug log)`.
///
/// PURE (no window, no `AppHandle`) so the fail-open mapping and its wording are
/// testable — the same `append_to` shape `agent/debuglog.rs` uses to keep a
/// global-state side effect out of the logic. `None` = no `WebviewWindow`
/// labelled `"main"` was resolvable from the countdown's thread; `Err(msg)` =
/// `is_focused()` refused, with its `Display`.
///
/// Both answer "not focused" — the fail-open rule this fn inherits verbatim —
/// and BOTH say which one they were, because under GNOME/Wayland the two are the
/// difference between "the probe lied about a real window" and "there was no
/// window to ask", and only the first is a focus problem.
pub(crate) fn focus_probe_trace(window: Option<Result<bool, String>>) -> (bool, String) {
    match window {
        // Named BY LABEL: a window that is not in the map at all (a label
        // mismatch, or a window the runtime does not expose to this thread) is
        // the candidate root cause a `Notify`-less countdown points at.
        None => (
            false,
            "attention: focus probe: no window labelled \"main\" — firing anyway (fail open)"
                .to_string(),
        ),
        Some(Err(e)) => (
            false,
            format!(
                "attention: focus probe: is_focused() refused: {e} — firing anyway (fail open)"
            ),
        ),
        // The boring case, still narrated: a `false` from a probe that worked is
        // a different diagnosis from a `false` from a probe that gave up.
        Some(Ok(focused)) => (
            focused,
            format!("attention: focus probe: is_focused()={focused}"),
        ),
    }
}

/// What asked for the webview's key focus, reduced to the two things the
/// decision needs. Pure so the platform matrix is testable off-Windows: the
/// `cfg` is evaluated at the CALL site (`cfg!(windows)`) and handed in as data,
/// so the branch that governs a platform this machine cannot compile for is
/// still a branch a test on Linux can execute.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum KeyFocusTrigger<'a> {
    /// `RunEvent::Ready` — fresh launch, the window revealed by
    /// `tauri-plugin-window-state` and never clicked.
    Ready,
    /// A `WindowEvent::Focused` carrying its `focused` flag and window label.
    WindowFocused(bool, &'a str),
}

/// Does this trigger ask for the webview's key focus, on this platform?
///
/// **Only the `Focused(true)` arm is gated, and only off Windows** — which is
/// the correction of a claim ADR 0057 records as verified. Its delivery matrix
/// says `Focused(true)` is not delivered on Windows, and from that it argued the
/// arm "cannot steal a sibling widget's focus". The conclusion was right about
/// the mechanism and wrong about the platform: Windows DOES route a focus event
/// here — `add_GotFocus` on the WebView2 controller sends
/// `SynthesizedWindowEvent::Focused(true)`
/// (`tauri-runtime-wry-2.11.4/src/lib.rs:5293-5310`) and the dispatcher turns it
/// into the same `RunEvent::WindowEvent` (`:4237-4252`). Two consequences, and
/// ADR 0057 was blind to both:
///
/// 1. On Windows the event means **WEBVIEW WIDGET** focus, not window
///    activation — precisely the case the safety argument ruled out. **Clicking
///    the webview fires it.**
/// 2. `Webview::set_focus()` on Windows is `MoveFocus(PROGRAMMATIC)`
///    (`wry-0.57.0/src/webview2/mod.rs:1583-1590`), and Microsoft defines that as
///    re-assigning focus inside the page — "focus is set to previously focused
///    element **or the default element** if no previously focused element
///    exists" (`ICoreWebView2Controller::MoveFocus`). So each click was answered
///    by a programmatic DOM focus move racing the click's own focus assignment:
///    the caret flickers out of the composer and the click never lands. That is
///    the reported Windows failure (ADR 0061).
///
/// `Ready` is deliberately kept on every platform, Windows included. It fires
/// once at launch, before any interaction, so it cannot participate in the loop
/// above; dropping it would change a Windows path that has shipped since v0.3.0
/// without a complaint about it, on the one platform this repo cannot test.
pub(crate) fn key_focus_grab_needed(is_windows: bool, trigger: &KeyFocusTrigger<'_>) -> bool {
    match trigger {
        // Fresh launch, every platform: the window the state plugin reveals holds
        // no widget key focus. Cannot fight a click — no click has happened yet.
        KeyFocusTrigger::Ready => true,
        // Activation re-assert. On Windows this is the WEBVIEW widget's focus
        // event, and re-asserting there breaks clicking, so Windows is excluded.
        KeyFocusTrigger::WindowFocused(true, "main") => !is_windows,
        _ => false,
    }
}

/// The webview key-focus attempt, reduced to its log line.
///
/// PURE (no window, no `AppHandle`) so the wording is testable — the same
/// `focus_probe_trace` shape one screen above, and for the same reason: the
/// mock runtime has no widget, so this is the half headless can pin, and
/// `tests/webview_key_focus.rs` owns the behaviour. `None` = no `WebviewWindow`
/// labelled `"main"` was resolvable from the event-loop callback; `Err(msg)` =
/// `Webview::set_focus()` refused, with its `Display`.
///
/// **Every arm returns a line** — nothing here is silent. A fix justified by a
/// measurement has to be readable in the field: "keys are dead and there is no
/// `focus:` line" must not be ambiguous between "the arm never ran" and "it ran
/// and succeeded", which is the same reasoning that makes `focus_probe_trace`
/// narrate its boring case. It is also what makes the deferred manual
/// measurement in `tests/webview_key_focus.rs` self-reading.
///
/// The impure wrapper's `debuglog::log` call is covered by these three lines
/// plus that ignored check — do NOT add a mock `App` to pin it: a second
/// `generate_context!()` in this test binary duplicates `embed_plist`'s
/// `_EMBED_INFO_PLIST` and reddens macOS `cargo test` while
/// `cargo clippy`/`check` stay green (they emit metadata only).
pub(crate) fn webview_focus_trace(lookup: Option<Result<(), String>>) -> Option<String> {
    match lookup {
        // Named BY LABEL: the label the config declares is `main`, so a `None`
        // here is either a label mismatch or an arm that ran before the window
        // existed — and those want different fixes.
        None => Some("focus: no window labelled \"main\" — key focus not grabbed".into()),
        Some(Err(e)) => Some(format!("focus: webview set_focus refused: {e}")),
        // The boring case, still narrated (see the doc comment): this line is
        // the evidence the manual measurement is waiting for.
        Some(Ok(())) => Some("focus: webview key focus grabbed".into()),
    }
}

/// Grab KEY focus for the webview WIDGET (not the window) — see ADR 0056, and
/// ADR 0061 for WHEN this may be called (never from a focus-in on Windows).
///
/// ⚠ The MECHANISM IS UNVERIFIED. The symptom is user-confirmed (no key reaches
/// JS at fresh launch until the window is clicked) but the reason is not: the
/// earlier theory that wry's creation-time `grab_focus()` lands on an unmapped
/// widget was REFUTED (see ADR 0056). This call is a candidate fix; the
/// measurement is deferred to `tests/webview_key_focus.rs -- --ignored`.
///
/// `window.as_ref()` resolves through `AsRef<Webview<R>> for WebviewWindow<R>`
/// — the only `AsRef`/`Deref` impl on that type, so it needs no disambiguation,
/// and `Webview::set_focus()` is ungated. Note `WebviewWindow::set_focus` is the
/// WRONG (window-level) sibling — the window-state plugin already calls that
/// one, and it is precisely what does not move the widget's key focus. The
/// ungated accessors are the only ones available: `Manager::get_webview`,
/// `webviews` and `get_focused_window` are all `#[cfg(feature = "unstable")]`
/// and this crate builds `tauri` with no features.
pub(crate) fn grab_webview_key_focus<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) {
    let line = webview_focus_trace(
        handle
            .get_webview_window("main")
            .map(|window| window.as_ref().set_focus().map_err(|e| e.to_string())),
    );
    if let Some(line) = line {
        debuglog::log(&line);
    }
}

/// The path to THIS executable that is guaranteed to still be spawnable.
///
/// `current_exe()` is not that. On Linux it is `readlink("/proc/self/exe")`, and
/// the kernel marks a replaced binary by appending the literal text
/// `" (deleted)"` to the target it prints. Cargo replaces `target/debug/archimedes`
/// **by unlinking and re-linking**, so a process still running the old inode reads
/// back `/…/target/debug/archimedes (deleted)` — a string that is not a path, and
/// `execve` on it fails `ENOENT`.
///
/// That is the `tauri dev` rebuild case, and it is not hypothetical: `make dev`
/// starts the app, any Rust edit relinks the binary under the running app, and
/// every Session started after that moment dies with
/// `spawn the session's Worker: worker error: io: spawn the worker: No such file
/// or directory (os error 2)`. The app itself keeps running fine (its image is
/// already mapped), so nothing else looks broken.
///
/// The magic link ITSELF is still resolvable — the kernel holds the unlinked
/// inode alive for the running process — so exec'ing the literal path
/// `/proc/self/exe` works after the on-disk name is gone. It must be the literal:
/// readlinking it first is exactly the call that produced the poisoned string.
///
/// The real path is preferred when it still exists, so nothing about a healthy
/// start changes: the AppImage case (where `current_exe()` resolves THROUGH the
/// FUSE mount to `/tmp/.mount_*/usr/bin/archimedes`, and that path is
/// load-bearing for the env scrub in `fulcrum_harness::hostenv`) and every
/// installed build keep the argv[0] they have always had. The fallback is only
/// reached when the name is gone.
///
/// Gated on `target_os = "linux"`, NOT `unix`: macOS is unix and has no `/proc`.
/// A `tauri dev` rebuild on macOS or Windows therefore still hits this — stated
/// rather than papered over, because neither fallback is verifiable from this
/// tree and a guess at `_NSGetExecutablePath` semantics here would be an
/// unmeasured claim about a platform nobody on this machine can run.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn worker_program_from(current_exe: std::path::PathBuf) -> std::path::PathBuf {
    if current_exe.exists() {
        return current_exe;
    }
    #[cfg(target_os = "linux")]
    {
        std::path::PathBuf::from("/proc/self/exe")
    }
    #[cfg(not(target_os = "linux"))]
    {
        // Nothing better exists here: the name is gone and there is no
        // magic-link equivalent to hand the spawner. Returning the dead path
        // keeps the failure the plain `ENOENT` it already was rather than
        // inventing a path that may exist and may not be this binary.
        current_exe
    }
}

/// The production `WorkerFactory` (the `current_exe()` Worker — the
/// `--worker` mode of this same binary; the `WorkerHandle`'s spawn
/// passes the flag). Tests inject the `fake_worker` fixture instead
/// (the `setup_dirs_with_factory` seam).
pub struct ProductionWorkerFactory;

impl WorkerFactory for ProductionWorkerFactory {
    fn spawn(&self) -> Result<WorkerHandle, crate::agent::worker::client::WorkerError> {
        let exe = std::env::current_exe().expect("the current exe (the Worker binary)");
        WorkerHandle::spawn(worker_program_from(exe).as_path())
    }
}
