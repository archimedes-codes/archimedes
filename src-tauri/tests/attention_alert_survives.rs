//! The MANUAL Linux checks behind a clickable Attention alert: a real alert on a
//! real desktop session, then a look at what the process is still holding and at
//! what the desktop reported back when the alert was clicked.
//!
//! ```text
//! cd src-tauri && cargo test --test attention_alert_survives -- --ignored --nocapture
//! ```
//!
//! # Why a person has to run these
//!
//! Two claims the design rests on cannot be observed from inside a test binary on
//! this machine, and both are about what the DESKTOP does rather than what our
//! code returns:
//!
//!   1. that an alert sent on a connection the process keeps for its whole life
//!      STAYS on screen — the premise that replaced the retention store;
//!   2. that a click on that alert's body reaches our subscription as an
//!      `ActionInvoked` naming the id we were given, and so becomes an
//!      `attention-alert-clicked` event.
//!
//! Each check below proves ONE of them and says which in its name, its `#[ignore]`
//! reason and its doc comment. Neither is asserted, and the reason is the same for
//! both: the witness lives outside the process. A test cannot see a banner, and
//! `ActionInvoked`/`NotificationClosed` are not broadcast to everyone — the daemon
//! emits a close AT a destination (measured during the ADR 0038 investigation:
//! `Sender=:1.17 Destination=:1.31`), so a subscription is not a trustworthy
//! witness of its own signals from a test binary whose `app_name` resolves to no
//! desktop file. So these checks print what they saw and a person reads it; the
//! parts that ARE answerable headlessly — the id→token map's policy, the exact
//! actions list, the log wording — are asserted in `attention_alert_click.rs` and
//! in `attention::delivery`'s own tests, not here.
//!
//! # What changed here, and why the old A/B pair is gone
//!
//! These checks used to prove that KEEPING the handle `notify_rust` answered with
//! kept an alert on screen: the plugin's shape (drop the handle, alert destroyed)
//! against ours (keep it, alert survives), side by side as a sender GNOME resolves
//! to an app. That pair measured a real bug and its real fix, and both are now
//! obsolete for a reason worth stating plainly: the fix is no longer "keep the
//! handle", it is "never have a per-alert connection to lose". The alert goes out
//! on one connection the process holds for ever, so there is no bus name for the
//! desktop to watch vanish, and the `Retained`/`RETAINED_ALERT_CAP` store the old
//! checks inspected does not exist. There is nothing left to A/B — hence one alert
//! per check now, and each one named for the half it proves.
//!
//! The desktop-entry machinery survives from the old second check
//! ([`desktop_entry_exists`], `ARCHIMEDES_ALERT_DESKTOP_ENTRY`), because the
//! claim it guards still holds: a sender GNOME cannot resolve to an app is exempt
//! from the destroy rule, so an unresolvable sender proves nothing about what a
//! real alert would have done. The click check needs the same care for a different
//! reason — an unresolvable sender may render no interactive banner at all, and a
//! click that was never possible proves nothing about a click that is.

// The gate is the SAME expression as the `notify-rust`/`zbus` dependency gate in
// `Cargo.toml` and as `attention::delivery`'s: on any other target there is no
// session bus to test against and no `notify-rust` to test with.
#![cfg(all(
    unix,
    not(any(target_os = "macos", target_os = "android", target_os = "ios"))
))]

use std::time::Duration;

use archimedes_lib::attention::delivery::bus::{
    pending_tokens, session_bus_delivery, token_of, track_alert,
};
use archimedes_lib::attention::delivery::Outcome;
use archimedes_lib::attention::AlertText;

/// How long to wait before deciding the alert was not destroyed. The destruction
/// ADR 0038 measured landed 22–25 ms after `Notify`, so three seconds is >100× the
/// bug's own window, and it is also long enough for a person to look at the screen.
const WATCH: Duration = Duration::from_secs(3);

/// The desktop session's notification server or nothing: this whole file is
/// meaningless without one, and the failure should say that.
fn server_name() -> String {
    match notify_rust::get_server_information() {
        Ok(info) => {
            println!(
                "server: {} {} (spec {})",
                info.name, info.version, info.spec_version
            );
            info.name
        }
        Err(e) => panic!(
            "no notification server answered on this session bus ({e}) — run these tests \
             at a desktop session, not in CI or over ssh"
        ),
    }
}

/// THE CONNECTION HALF: one alert sent on the process-lifetime connection is
/// still tracked — and still on screen — three seconds later.
///
/// What is asserted is the half a process can legitimately assert: the id the
/// server answered with is carried with its token, and survives the wait. That is
/// the structural claim of the new design — there is ONE connection and it is
/// never dropped, so nothing this process does can close the channel an alert
/// arrived on. The old check asserted the same shape about a retain store with a
/// cap of 8; there is no cap and nothing to evict now, so the surviving entry is
/// not "among what was kept", it is simply still there.
///
/// What only a person can confirm is printed rather than asserted: whether the
/// banner is still visible. See the module doc for why the test binary cannot
/// witness that, and the epilogue for why this binary's sender is not the sender
/// the ADR 0038 teardown applied to.
#[test]
#[ignore = "PROVES THE CONNECTION HALF: shows a real alert on this desktop, waits 3 s, and \
            checks the process still holds its id→token entry — run with \
            `cargo test --test attention_alert_survives -- --ignored --nocapture`"]
fn one_alert_on_the_long_lived_connection_survives_three_seconds() {
    server_name();

    // The real production send, through the real seam. The token is arbitrary
    // here — this check is about the entry surviving, and the token's content is
    // Rust-opaque by design (ADR 0039).
    let token = "manual-check-connection-half";
    let alert = AlertText {
        title: "Archimedes — manual check".into(),
        body: "This alert should STILL be on screen 3 s from now".into(),
        click_token: token.into(),
    };
    let outcome = session_bus_delivery(&alert);
    let id = match outcome {
        Outcome::Accepted { id } => {
            println!("the server accepted the alert: id={id}");
            id
        }
        other => panic!("the alert was not accepted ({other:?}) — nothing further can be checked"),
    };

    assert_eq!(
        token_of(id).as_deref(),
        Some("manual-check-connection-half"),
        "id={id} was accepted but is NOT tracked with its token — the click of \
         that alert could never be routed anywhere"
    );

    std::thread::sleep(WATCH);

    let tracked = pending_tokens();
    assert!(
        tracked.iter().any(|(seen, _)| *seen == id),
        "id={id} was accepted and then FORGOTTEN during the {WATCH:?} wait. Only a \
         `NotificationClosed` frees an entry, so a close here means the server \
         destroyed the alert on its own — the disappearance ADR 0038 measured, which \
         the one-connection design is meant to make impossible."
    );
    assert!(
        tracked
            .iter()
            .any(|(seen, held)| *seen == id && held == "manual-check-connection-half"),
        "id={id} is tracked but under a different token — a click would navigate \
         somewhere else: {tracked:?}"
    );

    println!(
        "checked: id={id} accepted, tracked with its token, and still tracked \
         {WATCH:?} later (outstanding: {tracked:?})"
    );
    println!(
        "LOOK AT THE SCREEN: if the banner is gone but the entry above survived, the \
         server closed the alert for its own reason (a timeout this app does not set — \
         the `Notify` call passes -1, the server's own) and the connection story is not \
         the whole answer."
    );
    println!(
        "what this does NOT prove: this binary's app_name resolves to no desktop file, so \
         GNOME's `if (this.app)` destroy never applied to it (see the module doc), and \
         whether the banner is VISIBLE is a human's observation, not an assertion. The \
         click half is `a_body_click_arrives_as_an_action_invoked_we_act_on`."
    );
}

/// THE CLICK HALF: a body click on a real alert arrives on our subscription as an
/// `ActionInvoked` naming the id the server gave us, and becomes an
/// `attention-alert-clicked` event carrying the token that alert was sent with.
///
/// Send the alert, then CLICK IT. The parts worth hard evidence are on the bus and
/// in the log, and the capture is the witness — the test prints the recipe and
/// what to look for:
///
/// ```text
/// (timeout 30 busctl --user monitor org.freedesktop.Notifications >/tmp/a.txt 2>&1 &)
/// ARCHIMEDES_DEBUG=1 cargo test --test attention_alert_survives a_body_click \
///     -- --ignored --nocapture
/// # …click the banner when it appears, then:
/// grep -n "ActionInvoked" /tmp/a.txt                     # the id + "default"
/// grep -n "attention: alert CLICKED" ~/.local/state/archimedes/supervisor.log
/// ```
///
/// `ActionInvoked` with the id printed below and the action string `default` is the
/// desktop's half. The line `attention: alert CLICKED (id=…) — emitting
/// attention-alert-clicked` is ours: it comes from the signal thread, so it proves
/// the subscription caught the signal and the token lookup succeeded. A capture
/// with the `ActionInvoked` and no such line means our rule or our thread is not
/// seeing what the server sent; the line with no navigation means the renderer
/// side (another task's) is not listening.
///
/// The alert is sent with `app_name` set to an installed desktop entry, because a
/// sender the desktop cannot resolve may render no interactive banner to click.
/// Without one this check gives up rather than print a negative for the wrong
/// reason.
#[test]
#[ignore = "PROVES THE CLICK HALF: shows a real alert on this desktop and waits for you to \
            click it, then reads the bus/log evidence that the ActionInvoked arrived — run \
            with `cargo test --test attention_alert_survives -- --ignored --nocapture`"]
fn a_body_click_arrives_as_an_action_invoked_we_act_on() {
    server_name();

    let entry = std::env::var("ARCHIMEDES_ALERT_DESKTOP_ENTRY")
        .unwrap_or_else(|_| "archimedes".to_string());
    if !desktop_entry_exists(&entry) {
        println!(
            "SKIP: no `{entry}.desktop` in the applications directories. Without a desktop \
             file the desktop may resolve the sender to no app and render nothing \
             clickable, so a click that never arrives would look like a broken \
             subscription when the fault is the missing entry. Install the app, or point \
             ARCHIMEDES_ALERT_DESKTOP_ENTRY at any installed .desktop name."
        );
        return;
    }

    // The token is what the click must come back with, so it is worth picking
    // something a log line makes unmistakable.
    let token = format!("manual-click-half-{}", std::process::id());
    let alert = AlertText {
        title: "Archimedes — manual click check".into(),
        body: format!("CLICK ME — the app_name is `{entry}`"),
        click_token: token.clone(),
    };

    // Sent the way production sends it (one connection, `["default", ""]`, the
    // server's own timeout), with the desktop entry swapped in so the sender
    // resolves to an app. `alert_payload`'s exact shape is used apart from that
    // one field — the point is to click the alert production would have shown.
    let id = send_as_app(&entry, &alert);
    println!("sent as `{entry}`: id={id}, token={token}");
    println!(
        "the alert is on screen. CLICK ITS BODY now (not a button — there is none: \
         the action is declared with an empty label)."
    );
    println!(
        "the bus recipe is in this test's doc comment. Watch for \
         `ActionInvoked` with id={id} and the action string `default`."
    );

    // Long enough to click, and to notice whether the banner vanished underfoot.
    std::thread::sleep(Duration::from_secs(20));

    let tracked = pending_tokens();
    match tracked.iter().find(|(seen, _)| *seen == id) {
        // The entry is gone and nobody clicked from this thread's point of view:
        // either the click fired (which removes it) or a close did. This is why
        // the log line, not the map, is the witness.
        None => println!(
            "id={id} is no longer tracked — either the click fired or the server closed \
             the alert. The log line is the tie-breaker: `attention: alert CLICKED \
             (id={id})` means the click."
        ),
        Some(_) => println!(
            "id={id} is STILL tracked: no `ActionInvoked` for it reached this process, \
             and no close either. If you did click, the subscription is not seeing the \
             signal — check the capture, and note that some servers (dunst is one) send \
             a notification's signals only to the connection that sent it, which is \
             exactly why the alert and the subscription share one connection."
        ),
    }
    println!(
        "what this does NOT prove: nothing about macOS or Windows — those platforms read \
         the click from `tauri-plugin-notification`'s `on_action` (`action_id() == \"tap\"`) \
         and there is no macOS or Windows host here. The connection half is \
         `one_alert_on_the_long_lived_connection_survives_three_seconds`."
    );
}

/// Send `alert` with `app_name` forced to `entry`, on the SAME connection
/// production uses, and return the id the server answered with.
///
/// The only difference from the production payload is the app name, which is what
/// makes the desktop resolve the sender to an app. It goes through
/// `zbus::blocking::Connection::session()` directly rather than
/// [`session_bus_delivery`] because that function composes its own payload and the
/// app name is part of it — so this helper repeats the `Notify` call, and repeats
/// the actions pair VERBATIM. If the pair ever changes in
/// `attention::delivery::bus::alert_payload`, this helper must change with it or
/// the manual check clicks an alert production no longer sends.
fn send_as_app(entry: &str, alert: &AlertText) -> u32 {
    let mut notification = notify_rust::Notification::new();
    notification.appname(entry);
    notification.summary(&alert.title);
    notification.body(&alert.body);
    notification.auto_icon();
    // The contract's pair, by hand — see the doc above for why this is a copy and
    // not a call. `action()` and not the deprecated `actions()`, as in `bus`.
    notification.action("default", "");

    let hints = std::collections::HashMap::<&str, zbus::zvariant::Value>::new();
    let connection = zbus::blocking::Connection::session()
        .expect("no session bus — these checks need a desktop session");
    let reply = connection
        .call_method(
            Some("org.freedesktop.Notifications"),
            "/org/freedesktop/Notifications",
            Some("org.freedesktop.Notifications"),
            "Notify",
            &(
                &notification.appname,
                0u32,
                &notification.icon,
                &notification.summary,
                &notification.body,
                &notification.actions,
                hints,
                -1i32,
            ),
        )
        .expect("the notification server refused the Notify call");
    let id: u32 = reply
        .body()
        .deserialize()
        .expect("the Notify reply was not a u32 id");
    // Tracked by hand, because the point of this helper is to send a payload
    // `session_bus_delivery` cannot compose; without this the map's state at the
    // end of the check would not mean what the printed message says it means.
    track_alert(id, alert.click_token.clone());
    id
}

/// Is there a `<entry>.desktop` for the desktop to resolve to? The two standard
/// XDG locations, which is where a user install and a system install land.
fn desktop_entry_exists(entry: &str) -> bool {
    let file = format!("{entry}.desktop");
    let home = std::env::var("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| dirs_home().join(".local/share"));
    [
        home.join("applications"),
        std::path::PathBuf::from("/usr/share/applications"),
    ]
    .iter()
    .any(|dir| dir.join(&file).is_file())
}

fn dirs_home() -> std::path::PathBuf {
    std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("/"))
}
