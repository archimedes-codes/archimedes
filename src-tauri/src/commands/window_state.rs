use serde::Serialize;

#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowFrameState {
    pub is_tiled: bool,
    pub is_maximized: bool,
    pub is_fullscreen: bool,
    pub native: bool,
}

#[cfg(target_os = "linux")]
pub const RELEVANT_STATE_MASK: gtk::gdk::WindowState = gtk::gdk::WindowState::from_bits_truncate(
    gtk::gdk::WindowState::TILED.bits()
        | gtk::gdk::WindowState::TOP_TILED.bits()
        | gtk::gdk::WindowState::RIGHT_TILED.bits()
        | gtk::gdk::WindowState::BOTTOM_TILED.bits()
        | gtk::gdk::WindowState::LEFT_TILED.bits()
        | gtk::gdk::WindowState::MAXIMIZED.bits()
        | gtk::gdk::WindowState::FULLSCREEN.bits(),
);

#[cfg(target_os = "linux")]
pub fn frame_state_from(state: gtk::gdk::WindowState) -> WindowFrameState {
    use gtk::gdk::WindowState;
    let is_tiled = state.intersects(
        WindowState::TILED
            | WindowState::TOP_TILED
            | WindowState::RIGHT_TILED
            | WindowState::BOTTOM_TILED
            | WindowState::LEFT_TILED,
    );
    WindowFrameState {
        is_tiled,
        is_maximized: state.contains(WindowState::MAXIMIZED),
        is_fullscreen: state.contains(WindowState::FULLSCREEN),
        native: true,
    }
}

pub fn should_emit(last: Option<WindowFrameState>, new_state: WindowFrameState) -> bool {
    match last {
        None => true,
        Some(prev) => prev != new_state,
    }
}

/// The raise attempt's three steps, reduced to (whether a window was there to
/// raise, the lines for the debug log).
///
/// PURE — no window, no `AppHandle` — so the ORDER of the steps and the wording
/// of every refusal are testable with no window and no desktop, in the same
/// shape [`crate::focus_probe_trace`] and [`crate::webview_focus_trace`] use for
/// the focus probe. The argument order IS the call order: `unminimize` → `show`
/// → `set_focus`, and that order is load-bearing rather than stylistic. tao's
/// Linux `set_focus()` is guarded by `!minimized && visible` and otherwise
/// **silently no-ops**, so a focus-first raise on a minimized window reports
/// success while doing nothing at all; `show()` has to precede it for the same
/// reason on a hidden window. Never reorder.
///
/// Exactly ONE line per step — success narrated, refusal named with the
/// platform's own `Display` — and a refusal of step N does NOT suppress step
/// N+1's line, because the calls themselves are not skipped (see
/// [`raise_attention_window`]).
///
/// `None` means the step was never performed because no window labelled `main`
/// resolved — and the three arguments are mapped off ONE resolution, so they
/// arrive together and a `None` anywhere is that same absence. It is reported
/// ONCE: three identical lines for calls that were never made would read as three
/// platform failures, and a line narrating a step that did not happen would be a
/// lie in the one place this feature's diagnosis lives.
///
/// ⚠ This function pins the SEQUENCE and the WORDING. It does not make the raise
/// a verified behaviour on any platform: the only local Windows proof is
/// `cargo check --target x86_64-pc-windows-gnu` (TYPE-CHECKING — no wine, no msvc
/// `lib.exe`) and there is no macOS host here, so whether the raise actually
/// surfaces a window under Windows or Wayland is UNVERIFIED.
///
/// [`crate::focus_probe_trace`]: crate::focus_probe_trace
/// [`crate::webview_focus_trace`]: crate::webview_focus_trace
pub fn raise_trace(
    unminimize: Option<Result<(), String>>,
    show: Option<Result<(), String>>,
    set_focus: Option<Result<(), String>>,
) -> (bool, Vec<String>) {
    // Each step is narrated on its own line, and no arm returns early: the
    // caller runs all three regardless of what an earlier one said.
    let step = |name: &str, done: &str, outcome: Result<(), String>| match outcome {
        Ok(()) => format!("attention: raise: {done}"),
        Err(e) => format!("attention: raise: {name} refused: {e}"),
    };

    match (unminimize, show, set_focus) {
        // The absence, named BY LABEL (the focus probe's convention for the same
        // reason): "there was no window to ask" is a different diagnosis from
        // "the window refused", and the raise is best-effort either way.
        (None, _, _) | (_, None, _) | (_, _, None) => (
            false,
            vec!["attention: raise: no window labelled \"main\" — not raised".to_string()],
        ),
        (Some(unminimize), Some(show), Some(set_focus)) => (
            true,
            vec![
                step("unminimize", "unminimized", unminimize),
                step("show", "shown", show),
                step("set_focus", "focused", set_focus),
            ],
        ),
    }
}

/// Raise the main window to the foreground — the click route of an Attention
/// alert (the renderer calls this when a click's token still names a live
/// Session, ADR 0103).
///
/// The three calls run in the order [`raise_trace`] documents and for the reason
/// it documents: `unminimize()` → `show()` → `set_focus()`, focus LAST because
/// tao's Linux `set_focus()` silently no-ops on a minimized or hidden window. A
/// refusal of one step does NOT stop the next — `unminimize()` on a window that
/// is already un-minimized is a no-op or an error depending on the platform, and
/// the two calls that could still bring the window forward must not be lost
/// because of it. Each step's outcome reaches the `ARCHIMEDES_DEBUG` log as the
/// one line `raise_trace` forms for it, so a report of "the alert was clicked and
/// nothing happened" is readable without attaching a debugger.
///
/// Best-effort by contract: the wire shape is `Ok(())` and there is no refusal to
/// surface to a user who has already clicked — including the no-window path. The
/// log is where the failure lands, not the IPC error channel.
///
/// ⚠ UNVERIFIED as BEHAVIOUR. The order and the lines are seam-tested
/// (`raise_trace`'s unit tests and the raise group in
/// `tests/attention_alert_click.rs`); whether the window actually surfaces on
/// Windows or under Wayland is TYPE-CHECKED and nothing more — no wine, no macOS
/// host, no compositor in this repository's checks.
#[tauri::command]
pub fn raise_attention_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    // The `get_window_state` precedent in this file resolves the window by label
    // from an `AppHandle` rather than taking a `WebviewWindow` parameter, so a
    // missing window is a `None` here instead of an argument-deserialization
    // error on the wire.
    let window = app.get_webview_window("main");
    // Each step is mapped off the SAME `Option`, so a `None` window yields three
    // `None`s — the absence `raise_trace` reports once. Every call is made
    // regardless of what an earlier one returned: no `?`, no early return.
    let unminimize = window
        .as_ref()
        .map(|w| w.unminimize().map_err(|e| e.to_string()));
    let show = window.as_ref().map(|w| w.show().map_err(|e| e.to_string()));
    let set_focus = window
        .as_ref()
        .map(|w| w.set_focus().map_err(|e| e.to_string()));

    let (_attempted, lines) = raise_trace(unminimize, show, set_focus);
    for line in lines {
        crate::agent::debuglog::log(&line);
    }

    // Best-effort: the click already happened, so there is nothing the renderer
    // could do with a refusal. Every outcome is in the log.
    Ok(())
}

/// Returns the current window frame state (tiled, maximized, fullscreen, native).
///
/// This command MUST stay synchronous (not `async`) because GTK calls are only
/// safe on the main thread, and Tauri executes non-async commands on the main thread.
#[tauri::command]
pub fn get_window_state(window: tauri::WebviewWindow) -> WindowFrameState {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        if let Ok(gtk_win) = window.gtk_window() {
            if let Some(gdk_win) = gtk_win.window() {
                return frame_state_from(gdk_win.state());
            }
            // Window not yet realized: check `gtk_win.is_maximized()` so
            // pre-realized maximized state is detected.
            return WindowFrameState {
                is_tiled: false,
                is_maximized: gtk_win.is_maximized(),
                is_fullscreen: false,
                native: true,
            };
        }
    }

    WindowFrameState {
        is_tiled: false,
        is_maximized: window.is_maximized().unwrap_or(false),
        is_fullscreen: window.is_fullscreen().unwrap_or(false),
        native: false,
    }
}

/// Connects GTK window state event notifications on Linux to emit Tauri events.
#[cfg(target_os = "linux")]
pub fn install_gtk_bridge<R: tauri::Runtime>(app: &tauri::App<R>) {
    use gtk::prelude::*;
    use std::cell::Cell;
    use tauri::{Emitter, Manager};

    let Some(main_win) = app.get_webview_window("main") else {
        eprintln!("window_state: main window not found");
        return;
    };

    let Ok(gtk_win) = main_win.gtk_window() else {
        eprintln!("window_state: failed to obtain gtk window");
        return;
    };

    let app_handle = app.handle().clone();
    let last_state = Cell::new(None);
    gtk_win.connect_window_state_event(move |_widget, event| {
        let changed = event.changed_mask();
        if changed.intersects(RELEVANT_STATE_MASK) {
            let current = frame_state_from(event.new_window_state());
            if should_emit(last_state.get(), current) {
                last_state.set(Some(current));
                if let Err(e) = app_handle.emit("window-state-changed", current) {
                    eprintln!("window_state: failed to emit window-state-changed: {e}");
                }
            }
        }

        gtk::glib::Propagation::Proceed
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn relevant_state_mask_contains_expected_window_states() {
        use gtk::gdk::WindowState;

        assert!(RELEVANT_STATE_MASK.contains(WindowState::TILED));
        assert!(RELEVANT_STATE_MASK.contains(WindowState::TOP_TILED));
        assert!(RELEVANT_STATE_MASK.contains(WindowState::RIGHT_TILED));
        assert!(RELEVANT_STATE_MASK.contains(WindowState::BOTTOM_TILED));
        assert!(RELEVANT_STATE_MASK.contains(WindowState::LEFT_TILED));
        assert!(RELEVANT_STATE_MASK.contains(WindowState::MAXIMIZED));
        assert!(RELEVANT_STATE_MASK.contains(WindowState::FULLSCREEN));
        assert!(!RELEVANT_STATE_MASK.contains(WindowState::ICONIFIED));
        assert!(!RELEVANT_STATE_MASK.contains(WindowState::STICKY));
    }

    #[test]
    fn window_frame_state_serializes_to_camel_case() {
        let state = WindowFrameState {
            is_tiled: true,
            is_maximized: false,
            is_fullscreen: true,
            native: true,
        };
        let json = serde_json::to_string(&state).expect("failed to serialize");
        assert_eq!(
            json,
            r#"{"isTiled":true,"isMaximized":false,"isFullscreen":true,"native":true}"#
        );
    }

    #[test]
    fn should_emit_deduplicates_identical_states() {
        let s1 = WindowFrameState {
            is_tiled: false,
            is_maximized: false,
            is_fullscreen: false,
            native: true,
        };
        let s2 = WindowFrameState {
            is_tiled: true,
            is_maximized: false,
            is_fullscreen: false,
            native: true,
        };

        // When no previous state, should emit
        assert!(should_emit(None, s1));
        // When state changed, should emit
        assert!(should_emit(Some(s1), s2));
        // When state is identical, should not emit
        assert!(!should_emit(Some(s1), s1));
    }

    // ---- the raise (the attention-alert click route) -----------------------
    //
    // The three lines below pin the PURE trace: the ORDER, and the exact wording
    // of every arm. They are the whole headless proof the raise can have — no
    // window, no `AppHandle`, no compositor. What they do NOT prove is that the
    // raise WORKS on any platform (see `raise_trace`'s doc comment).

    /// Every step of a clean raise gets its OWN narrated line, in the order the
    /// calls happen: `unminimize` → `show` → `set_focus`.
    ///
    /// The order is load-bearing, not stylistic — tao's Linux `set_focus()` is
    /// guarded by `!minimized && visible` and otherwise silently no-ops, so a
    /// focus-first raise on a minimized window reports success while doing
    /// nothing. Hence this test asserts the ORDER of the lines and not just their
    /// presence.
    #[test]
    fn raise_trace_narrates_every_step_in_order() {
        let (attempted, lines) = raise_trace(Some(Ok(())), Some(Ok(())), Some(Ok(())));

        assert!(attempted, "a window that was resolved was attempted");
        assert_eq!(
            lines,
            vec![
                "attention: raise: unminimized",
                "attention: raise: shown",
                "attention: raise: focused",
            ],
            "one line per step, unminimize first and set_focus last"
        );
        assert_eq!(lines.len(), 3, "exactly three steps, so none is skipped");
        for line in &lines {
            assert!(
                line.starts_with("attention: raise: "),
                "every raise line carries the prefix that makes it greppable: {line}"
            );
        }
    }

    /// A refusal names WHICH step refused and still lets the later steps speak.
    ///
    /// The load-bearing half is the SECOND assertion: a refusal of step N must
    /// not skip step N+1. `unminimize()` on a window that is not minimized is a
    /// no-op or an error depending on the platform, and `show()`/`set_focus()`
    /// can still succeed after it — an early return there would leave the window
    /// un-raised on precisely the platform the feature exists for.
    #[test]
    fn raise_trace_names_the_refusing_step_and_never_stops_early() {
        let (attempted, lines) = raise_trace(
            Some(Err("window is not minimized".into())),
            Some(Ok(())),
            Some(Ok(())),
        );

        assert!(
            attempted,
            "the raise was still attempted — a refusal is not an absence"
        );
        assert_eq!(
            lines.first().map(String::as_str),
            Some("attention: raise: unminimize refused: window is not minimized"),
            "the refusal is its OWN line and names the step that refused"
        );
        assert_eq!(
            lines,
            vec![
                "attention: raise: unminimize refused: window is not minimized",
                "attention: raise: shown",
                "attention: raise: focused",
            ],
            "a refused step 1 does NOT skip steps 2 and 3 — three lines regardless"
        );

        // The other two refusals name themselves too (a generic "the raise
        // failed" line would not say which call the platform rejected).
        let (_, show_refused) = raise_trace(Some(Ok(())), Some(Err("nope".into())), Some(Ok(())));
        assert_eq!(
            show_refused,
            vec![
                "attention: raise: unminimized",
                "attention: raise: show refused: nope",
                "attention: raise: focused",
            ]
        );

        let (_, focus_refused) =
            raise_trace(Some(Ok(())), Some(Ok(())), Some(Err("denied".into())));
        assert_eq!(
            focus_refused,
            vec![
                "attention: raise: unminimized",
                "attention: raise: shown",
                "attention: raise: set_focus refused: denied",
            ],
            "the focus refusal quotes the platform's own Display"
        );
    }

    /// No window labelled `main` is ONE line, not three, and not a panic.
    ///
    /// The three steps arrive together (they are mapped off ONE window
    /// resolution), so the trace reports the absence once. This is the case the
    /// `attention` focus probe names explicitly for the same reason: "there was
    /// no window to ask" is a different diagnosis from "the window refused", and
    /// the raise is best-effort either way.
    #[test]
    fn raise_trace_reports_a_missing_window_once() {
        let (attempted, lines) = raise_trace(None, None, None);

        assert!(!attempted, "nothing was attempted when there was no window");
        assert_eq!(
            lines,
            vec!["attention: raise: no window labelled \"main\" — not raised"],
            "one line naming the missing label, and nothing else"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn frame_state_from_maps_gdk_window_state_bits() {
        use gtk::gdk::WindowState;

        let empty = frame_state_from(WindowState::empty());
        assert_eq!(
            empty,
            WindowFrameState {
                is_tiled: false,
                is_maximized: false,
                is_fullscreen: false,
                native: true,
            }
        );

        let tiled = frame_state_from(WindowState::TILED);
        assert!(tiled.is_tiled);
        assert!(!tiled.is_maximized);
        assert!(!tiled.is_fullscreen);
        assert!(tiled.native);

        let left_tiled = frame_state_from(WindowState::LEFT_TILED);
        assert!(left_tiled.is_tiled);
        assert!(!left_tiled.is_maximized);
        assert!(left_tiled.native);

        let right_tiled = frame_state_from(WindowState::RIGHT_TILED);
        assert!(right_tiled.is_tiled);

        let top_tiled = frame_state_from(WindowState::TOP_TILED);
        assert!(top_tiled.is_tiled);

        let bottom_tiled = frame_state_from(WindowState::BOTTOM_TILED);
        assert!(bottom_tiled.is_tiled);

        let maximized = frame_state_from(WindowState::MAXIMIZED);
        assert!(!maximized.is_tiled);
        assert!(maximized.is_maximized);
        assert!(!maximized.is_fullscreen);
        assert!(maximized.native);

        let fullscreen = frame_state_from(WindowState::FULLSCREEN);
        assert!(!fullscreen.is_tiled);
        assert!(!fullscreen.is_maximized);
        assert!(fullscreen.is_fullscreen);
        assert!(fullscreen.native);

        let tiled_and_maximized = frame_state_from(WindowState::TILED | WindowState::MAXIMIZED);
        assert!(tiled_and_maximized.is_tiled);
        assert!(tiled_and_maximized.is_maximized);
        assert!(tiled_and_maximized.native);
    }
}
