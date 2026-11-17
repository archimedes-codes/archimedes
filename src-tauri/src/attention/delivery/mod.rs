//! The production [`Delivery`] — an alert's route to the screen, and the only
//! place in this crate that talks to a notification server.
//!
//! Two transports, picked at compile time, because the platforms do not fail
//! the same way:
//!
//! * Linux and the BSDs send the alert themselves on ONE session-bus connection
//!   the process owns for its whole life ([`bus`]). The alert used to go out on
//!   a connection per alert (`notify_rust`'s `show()` opens one per send) and
//!   then had to be RETAINED, because the desktop destroys an alert when the
//!   connection that sent it dies (ADR 0038: the FDO daemon name-watches the
//!   sender, and its handler ends in `if (this.app) this.destroy()` — measured
//!   22–25 ms after `Notify` on GNOME 50.5). With one connection the desktop has
//!   no per-alert bus name to watch vanish, so that teardown is not mitigated
//!   here, it is structurally impossible — and the same connection is what the
//!   ONE signal thread subscribes on, which is how a body click is observed at
//!   all.
//! * macOS and Windows keep the plugin ([`plugin`]). A notification there is not
//!   a D-Bus message with a sender, so there is no bus name for it to die with,
//!   and the plugin reports a body click through its own `on_action` callback.
//!
//! Both transports carry the alert's `click_token` (ADR 0039: the renderer owns
//! the vocabulary, Rust holds one opaque string it cannot read) and both echo it
//! back on the `attention-alert-clicked` event when the OS reports the alert was
//! clicked.
//!
//! The other thing this module owns is what the debug log may SAY about a
//! delivery. "The alert never appeared" is THE support question for this feature
//! (`attention`'s module doc), and the two transports know very different
//! amounts about what just happened: one has the id the server answered with,
//! the other has a call that returned. [`Outcome`] is the seam that stops the
//! wording claiming more than the transport knows, and it is pure (no bus, no
//! window, no server) so the wording itself is tested. Alert TEXT — and the
//! click token, which is a Session id — never comes near it: the trace carries
//! ids and errors only.

// The gate below is the platform set `tauri-plugin-notification` builds
// `notify-rust` for, written as a subtraction: every `unix` except macOS (its
// own notification service) and the two `unix` mobiles (no session bus — the
// plugin's own target list excludes them too, so `cfg(unix)` alone would ask
// `notify-rust` to build where it cannot). The SAME expression gates the
// `notify-rust`/`zbus` dependencies in `Cargo.toml`, and the two must stay
// equal: the code may not name those crates on a target that does not have them.
#[cfg(all(
    unix,
    not(any(target_os = "macos", target_os = "android", target_os = "ios"))
))]
pub mod bus;

// The doc lives INSIDE the module (`//!`), matching the sibling `bus` module:
// an outer `///` on a `mod` whose body opens with `//!` is `mixed_attributes_style`,
// which is a hard error under the AGENTS.md `-D warnings`, and this module only
// compiles on macOS/Windows — so the Linux bar that ran here could not see it.
#[cfg(not(all(
    unix,
    not(any(target_os = "macos", target_os = "android", target_os = "ios"))
)))]
pub mod plugin;

#[cfg(all(
    unix,
    not(any(target_os = "macos", target_os = "android", target_os = "ios"))
))]
pub use bus::{production, session_bus_delivery};

#[cfg(not(all(
    unix,
    not(any(target_os = "macos", target_os = "android", target_os = "ios"))
)))]
pub use plugin::production;

/// What one delivery attempt learned about the alert it sent.
///
/// The variants ARE the difference between the platforms, and the debug line is
/// derived from this and nothing else — a transport cannot claim an id it was
/// never given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Linux and the BSDs: the server ANSWERED the `Notify` call with this id.
    /// That is evidence it took the alert — not evidence that anything reached
    /// the screen. The id is also the key the click token is stored under, which
    /// is the only thing this variant is used for beyond the log line; it
    /// deliberately carries nothing else, so no line can name an alert this send
    /// displaced (there is no longer a store that displaces anything).
    Accepted { id: u32 },
    /// macOS and Windows: the plugin took the notification and reported only
    /// that. Its `show()` spawns the real send and discards the result, so `Ok`
    /// says the builder call returned and nothing about the desktop.
    HandedOff,
    /// The call refused the alert, with its `Display` (usually "no notification
    /// server on this session").
    Refused(String),
}

/// The debug line for one delivery attempt.
///
/// PURE so the wording is testable with no notification server running — the
/// same `focus_probe_trace` shape. The caller throws the line at the log and
/// nothing else: ADR 0038's promise that a failed delivery is silent TO THE USER
/// is untouched, and the log is the only new listener.
pub fn delivery_trace(outcome: &Outcome) -> String {
    match outcome {
        // The id is what the server ANSWERED with, which is the strongest claim
        // the sender can make: the alert reached the server. Whether it stayed on
        // screen is the server's doing from here — and nothing WE do afterwards
        // can make an older alert disappear, because one connection is held for
        // the whole process and no alert is ever evicted.
        Outcome::Accepted { id } => {
            format!("attention: alert ACCEPTED by the notification server (id={id})")
        }
        // The plugin hands the notification to a task that discards what the
        // notification library says (`desktop.rs`: `let _ = notification
        // .show();`), so an `Ok` here is a handover and nothing more. Saying
        // "delivered" would be the lie that sent someone to a D-Bus capture.
        Outcome::HandedOff => concat!(
            "attention: alert handed to the notification plugin, which reports nothing ",
            "back (no id, no proof it reached a server)"
        )
        .to_string(),
        Outcome::Refused(e) => format!("attention: alert delivery FAILED: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{delivery_trace, Outcome};

    // The dropped-signal line belongs to the bus transport, which exists on no
    // other target — so both the import and its test carry the SAME gate as the
    // module (and as the `zbus` dependency in `Cargo.toml`).
    #[cfg(all(
        unix,
        not(any(target_os = "macos", target_os = "android", target_os = "ios"))
    ))]
    use super::bus::dropped_signal_trace;

    // ---- the log line (what the delivery is allowed to claim) --------------

    /// The session-bus success line carries the id the SERVER assigned: that
    /// number is the only evidence in hand that the alert was accepted, and it
    /// is what a support answer points at.
    #[test]
    fn the_success_line_carries_the_id_the_server_gave() {
        let line = delivery_trace(&Outcome::Accepted { id: 42 });
        assert!(line.starts_with("attention:"), "{line}");
        assert!(
            line.contains("42"),
            "the server's id is in the line: {line}"
        );
        assert!(
            !line.contains("returned Ok"),
            "the old line asserted the one thing nobody can know: {line}"
        );
    }

    /// The line that REPLACES `the_line_names_a_released_alert`: nothing is
    /// released any more, so the accepted line must not mention a cap, a
    /// retention, or a released alert at all.
    ///
    /// The old test pinned the wording of an eviction; the eviction is gone with
    /// the `Retained` store (one connection per process, so there is nothing to
    /// count and nothing to evict), and what is worth pinning now is that the
    /// line cannot claim a side effect the sender no longer has. A sentence about
    /// releasing an older alert would send a reader hunting for a bug in a
    /// mechanism that does not exist.
    #[test]
    fn the_accepted_line_never_mentions_a_released_alert() {
        let line = delivery_trace(&Outcome::Accepted { id: 42 });
        let lowered = line.to_lowercase();
        for forbidden in ["cap", "retain", "released", "release", "evict", "oldest"] {
            assert!(
                !lowered.contains(forbidden),
                "the accepted line must not speak of releasing an alert (there is \
                 no retain store any more): {line}"
            );
        }
        assert!(
            line.matches("id=").count() <= 1,
            "one id — the alert this call sent — and no second id for an alert \
             that was dropped: {line}"
        );
    }

    /// The failure line still carries the error's `Display` (the standing rule:
    /// "we tried and the OS said no" must be tellable apart from "we never
    /// tried").
    #[test]
    fn the_failure_line_names_the_error() {
        let line = delivery_trace(&Outcome::Refused("no notification server".into()));
        assert!(line.contains("FAILED"), "a failure is labelled: {line}");
        assert!(line.contains("no notification server"), "{line}");
    }

    /// The plugin path cannot see the desktop at all, so its line must not read
    /// like a delivery report.
    #[test]
    fn the_plugin_line_admits_it_knows_nothing() {
        let line = delivery_trace(&Outcome::HandedOff);
        assert!(line.starts_with("attention:"), "{line}");
        assert!(
            !line.contains("delivered"),
            "the plugin never says the alert got anywhere: {line}"
        );
        assert!(
            !line.contains("returned Ok"),
            "not even the call's shape is a delivery claim: {line}"
        );
        assert!(
            line.contains("plugin") && (line.contains("nothing") || line.contains("no id")),
            "the line says who holds the alert now and what is unknown: {line}"
        );
    }

    /// The standing rule, restated where the alert's text is in scope: nothing
    /// a delivery emits ever carries the alert's words.
    #[test]
    fn no_line_carries_the_alert_text() {
        for outcome in [
            Outcome::Accepted { id: 1 },
            Outcome::HandedOff,
            Outcome::Refused("boom".into()),
        ] {
            let line = delivery_trace(&outcome);
            assert!(
                !line.contains("api-server") && !line.contains("waiting for you"),
                "{line}"
            );
        }
    }

    // ---- the dropped-signal line (a read error the thread survives) --------

    /// A failed signal READ names itself as a DROPPED SIGNAL, quotes the error,
    /// and does not claim the listener went away.
    ///
    /// `watch` deliberately keeps looping when a read fails — one bad message
    /// must not make the app permanently deaf — but it must not be INVISIBLE
    /// either: if signals are being dropped the token map stops being pruned and
    /// a click is lost, and "no navigation happened" is exactly the support
    /// question this module exists to make answerable. Hence the line has to say
    /// (a) a signal was dropped, (b) why, and (c) that the loop went on.
    ///
    /// The seam is pure, so this needs no `MessageIterator` and no `AppHandle`:
    /// `zbus::Error` has public constructible variants, and a test builds one
    /// from thin air — the same reason `delivery_trace` exists. Building a fake
    /// iterator or a real `App` is forbidden here for the `_EMBED_INFO_PLIST`
    /// reason `webview_focus_trace`'s doc records.
    #[cfg(all(
        unix,
        not(any(target_os = "macos", target_os = "android", target_os = "ios"))
    ))]
    #[test]
    fn a_dropped_signal_names_itself_as_dropped_and_keeps_the_listener_up() {
        let error = zbus::Error::Failure("the socket reader task went away".into());
        let line = dropped_signal_trace(&error);

        assert!(line.starts_with("attention: "), "{line}");
        let lowered = line.to_lowercase();
        assert!(lowered.contains("dropped"), "a drop says so: {line}");
        assert!(lowered.contains("signal"), "it names what was lost: {line}");
        assert!(
            line.contains("the socket reader task went away"),
            "the error's own Display survives verbatim, the standing rule: {line}"
        );
        // The anti-claim: the thread CONTINUES, so a line that read as a
        // shutdown would send a reader to the wrong diagnosis (and a real
        // shutdown has its own line, `the notification signal thread ended`).
        assert!(
            !lowered.contains("ended"),
            "a drop is not a shutdown: {line}"
        );
        assert!(!lowered.contains("deaf"), "the listener stays up: {line}");
    }
}
