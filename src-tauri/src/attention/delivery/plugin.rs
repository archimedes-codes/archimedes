//! macOS, Windows and anything mobile: hand the alert to
//! `tauri-plugin-notification`, which has no bus-name semantics to keep
//! alive. A macOS/Windows notification is not a D-Bus message: there is no
//! sender's bus name for the desktop to watch, so the XDG retention
//! machinery would buy nothing and cost a dependency, and the plugin's own
//! platform handling (bundle identifier on macOS, AUMID on Windows) stays
//! in charge.
//!
//! The click rides the plugin's own channel instead: the token is set as the
//! notification's `attentionToken` extra, and `on_action` — registered ONCE,
//! here — reads it back off the notification the action names. A body click
//! arrives as `action_id() == "tap"`, which is what the plugin maps the
//! platform's "the notification itself was activated" onto.

use std::sync::Arc;

use tauri::Emitter;
// At module level and not inside each fn: BOTH halves need it — `show()` in
// [`plugin_delivery`] and `on_action` in [`production`] are `NotificationExt`
// methods, and a per-fn import would leave the other half unable to compile.
// (This is exactly what the `x86_64-pc-windows-gnu` check caught: on Linux the
// whole module is `cfg`'d out, so no Linux gate can see it.)
use tauri_plugin_notification::NotificationExt;

use crate::agent::debuglog;
use crate::attention::{AlertText, Delivery};

use super::Outcome;

/// The `extra` key the click token travels under, and the body click's
/// `action_id` — both part of the fixed wire contract, spelled as literals
/// because nothing on either side cross-checks them.
const TOKEN_EXTRA_KEY: &str = "attentionToken";
/// What the plugin reports a click on the notification itself as.
const BODY_CLICK_ACTION: &str = "tap";

/// Hand one alert to the plugin. `Ok` means the call returned and NOTHING
/// else: the plugin spawns the real send and discards its result
/// (`tauri-plugin-notification` 2.6.0, `desktop.rs`), so whether anything
/// reached the screen is unknowable from here.
fn plugin_delivery<R: tauri::Runtime>(app: &tauri::AppHandle<R>, text: &AlertText) -> Outcome {
    match app
        .notification()
        .builder()
        .title(&text.title)
        .body(&text.body)
        // The token travels as `extra`, which the plugin serialises into the
        // notification payload and hands back on the action — the only route
        // from "this notification was clicked" to "and it was raised by
        // this". It is passed through verbatim: no cap, no trim, and the
        // alert's own text caps are not on this path.
        .extra(TOKEN_EXTRA_KEY, text.click_token.clone())
        .show()
    {
        Ok(()) => Outcome::HandedOff,
        Err(e) => Outcome::Refused(e.to_string()),
    }
}

/// The [`Delivery`] for the platforms that keep the plugin.
///
/// Registers the ONE click listener here, at startup: `on_action` appends to
/// a handler list, so registering per alert would give the first alert's
/// handler a second chance to emit on the tenth alert's click — a click
/// multiplied by the number of alerts sent.
pub fn production<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Delivery {
    let app = app.clone();
    let listener = app.clone();
    if let Err(e) = app.notification().on_action(
        move |performed: &tauri_plugin_notification::ActionPerformed| {
            // A body click only. A notification's own action buttons (and
            // a `dismiss` report on iOS) are not "take me there".
            if performed.action_id() != BODY_CLICK_ACTION {
                return;
            }
            // The token comes back on the notification the plugin names.
            // `None` here means the action arrived with no notification
            // payload to read — nothing to route, so nothing is emitted
            // rather than a click with a made-up token.
            let Some(token) = performed
                .notification()
                .and_then(|notification| notification.extra().get(TOKEN_EXTRA_KEY))
                .and_then(|value| value.as_str())
            else {
                debuglog::log(
                    "attention: a notification was tapped but carried no \
                         `attentionToken` — nothing emitted",
                );
                return;
            };
            debuglog::log("attention: alert CLICKED — emitting attention-alert-clicked");
            // The token verbatim, as on every other transport (ADR 0039).
            let _ = listener.emit(
                "attention-alert-clicked",
                serde_json::json!({ "token": token }),
            );
        },
    ) {
        // A listener that never registered means clicks do nothing on this
        // platform, which the delivery lines cannot say (they describe a
        // send, not the listener). Say it once, here, and keep delivering:
        // an alert the user cannot click still beats no alert at all.
        debuglog::log(&format!(
            "attention: the notification action listener could not be registered ({e}) — \
             an alert that is clicked will not navigate"
        ));
    }
    Arc::new(move |text: &AlertText| {
        let outcome = plugin_delivery(&app, text);
        debuglog::log(&super::delivery_trace(&outcome));
    })
}
