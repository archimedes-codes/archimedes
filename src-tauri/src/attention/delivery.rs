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
pub mod bus {
    //! Linux and the BSDs: ONE process-lifetime session-bus connection. Every
    //! alert is sent on it and its single signal thread watches it for the
    //! click. There is no per-alert bus name, so the desktop has nothing to
    //! watch vanish — the teardown ADR 0038 measured is structurally impossible
    //! here — and the same subscription is what makes a body click observable.
    //! See [`super::plugin`] for the platforms that have no bus to speak of.

    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use tauri::Emitter;

    use crate::agent::debuglog;
    use crate::attention::{AlertText, Delivery};

    use super::Outcome;

    /// The bus name, object path and interface of the Desktop Notifications
    /// Specification — the SAME server the plugin talks to (mirrored from
    /// `tauri-plugin-notification` 2.6.0 `desktop.rs`'s `BUS`, because this
    /// transport deliberately does not depend on the plugin's constants).
    const BUS: (&str, &str, &str) = (
        "org.freedesktop.Notifications",
        "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications",
    );

    /// The action id a body click is reported under, and the ONLY one this
    /// transport turns into a click. Declaring it in the alert's actions list is
    /// what makes a click on the notification itself observable at all; the
    /// empty label that pairs with it on the wire renders no button.
    const DEFAULT_ACTION: &str = "default";

    /// One connection, opened lazily on the first delivery and held for the life
    /// of the process. `Mutex<Option<…>>` so `production()` stays pure and the
    /// open happens where it is first needed — the same shape as the plugin's
    /// `OnceLock<Option<zbus::blocking::Connection>>` (`desktop.rs`'s `Tracker`),
    /// with a `Mutex` instead because ours is written by the delivery thread
    /// that first needs it and read by the signal thread for ever after.
    ///
    /// It is never evicted: the signal thread holds its own clone, and
    /// `zbus::blocking::Connection` is a cheap `Clone` over an `Arc`, so the
    /// entry closing would mean the app's alerts going deaf mid-session.
    static CONNECTION: Mutex<Option<zbus::blocking::Connection>> = Mutex::new(None);

    /// The alerts this process sent and the server has not closed yet: the id
    /// the server ANSWERED with, mapped to the token the renderer sent with it.
    ///
    /// `Mutex<Option<HashMap<…>>>` only because `HashMap::new` is not `const` —
    /// `tracked()` opens the map on first use, so the entry is `None` solely
    /// before the first alert.
    ///
    /// BOUNDED BY OUTSTANDING ALERTS, not by the process lifetime: `on_signal`
    /// removes an entry on `ActionInvoked` (so one alert cannot fire two
    /// navigations) and on `NotificationClosed` (so a dismissed or expired alert
    /// frees its entry). That is the whole replacement for the deleted
    /// `Retained`/`RETAINED_ALERT_CAP` store — a count of connections was needed
    /// when each alert owned one; a map of live alerts is freed by the server's
    /// own close signal.
    ///
    /// The key is a `u32` DELIBERATELY, and it is not the same thing as the
    /// plugin's `i32`: `u32` is the wire type of BOTH halves of this exchange —
    /// the reply to `Notify` and the first field of `ActionInvoked`/
    /// `NotificationClosed` — so no conversion sits between the server's id and
    /// our key. The plugin's `i32` is its OWN monotonic notification identifier
    /// (`Tracker::shown` holds `(i32, Value)` under a `u32` server id), a
    /// different number for a different purpose. Do not "unify" them.
    static TOKENS: Mutex<Option<HashMap<u32, String>>> = Mutex::new(None);

    /// The map every entry of the process holds, opened on first use.
    ///
    /// `unwrap_or_else(into_inner)` because a panic while holding this lock
    /// would leave a poisoned map that makes every later alert panic too: the map
    /// is `HashMap<u32, String>` with no invariant a panic could have broken
    /// mid-update, so continuing with the contents is strictly better than
    /// turning one delivery's bug into the app's permanent deafness.
    fn tracked() -> std::sync::MutexGuard<'static, Option<HashMap<u32, String>>> {
        TOKENS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The server ids currently carried with their tokens.
    ///
    /// `pub` ONLY so the ignored manual checks (`tests/attention_alert_survives.rs`)
    /// can match a real server's id against the token it was sent with, and so
    /// the headless seam test (`tests/attention_alert_click.rs`) can read the map
    /// it drives. Production never consults it.
    pub fn pending_tokens() -> Vec<(u32, String)> {
        let mut entries = tracked()
            .as_ref()
            .map(|map| {
                map.iter()
                    .map(|(id, token)| (*id, token.clone()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        // Sorted so a reader (and a test's failure message) sees a stable order;
        // the map itself has none.
        entries.sort();
        entries
    }

    /// The token tracked for `server_id`, if the alert is still outstanding.
    /// `pub` for the tests, for the same reason as [`pending_tokens`].
    pub fn token_of(server_id: u32) -> Option<String> {
        tracked()
            .as_ref()
            .and_then(|map| map.get(&server_id))
            .cloned()
    }

    /// Record that the server accepted `server_id` as this alert, with the token
    /// a click on it must echo back VERBATIM. `pub` for the tests, which drive
    /// the map without a server; production reaches it through
    /// [`session_bus_delivery`].
    ///
    /// An id the server REUSES (it may hand out an old number again after
    /// closing that alert) overwrites rather than stacks: one id is one alert.
    pub fn track_alert(server_id: u32, token: String) {
        let mut slot = tracked();
        slot.get_or_insert_with(HashMap::new)
            .insert(server_id, token);
    }

    /// Free one entry, returning the token it held. `pub` for the tests; the
    /// signal thread reaches it through [`on_signal`].
    pub fn untrack_alert(server_id: u32) -> Option<String> {
        let mut slot = tracked();
        // `as_mut()` and not `as_mut().map(…)` — no map, nothing tracked, so
        // there is nothing to remove and no map to conjure for the question.
        slot.as_mut().and_then(|map| map.remove(&server_id))
    }

    /// The one signal of the notification server this transport acts on, reduced
    /// from a D-Bus message to the two facts that matter: which alert, and which
    /// of the two members.
    ///
    /// The seam [`on_signal`] is written against. A test builds one of these from
    /// thin air; the signal thread gets it off the bus with [`signal_of`]. Keeping
    /// the two apart is what makes the click policy testable with no server.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum Signal {
        /// The user performed an action on an alert. `action` is the id the
        /// server names, which is [`DEFAULT_ACTION`] for a click on the
        /// notification itself.
        ActionInvoked { server_id: u32, action: String },
        /// The server is done with an alert — dismissed, expired, or replaced.
        /// The close REASON is deliberately absent: nothing here branches on it,
        /// and an unread field would only invite someone to.
        NotificationClosed { server_id: u32 },
    }

    /// What [`on_signal`] decided, so the thread knows whether to emit and a
    /// test can assert the decision instead of a side effect.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum SignalOutcome {
        /// A body click on an alert WE sent: the token to echo, verbatim.
        Clicked { server_id: u32, token: String },
        /// An action on one of our alerts that was not the body click. Ignored —
        /// and the alert STAYS tracked, because its body click is still owed.
        OtherAction { server_id: u32, action: String },
        /// A signal about an alert this process never sent (another app's, or
        /// ours from before a restart — the subscription is a broadcast). Never a
        /// click: a token we do not hold is a token we cannot echo, and guessing
        /// one would navigate the user to the wrong Session.
        Untracked { server_id: u32 },
        /// The server closed an alert. `was_tracked` distinguishes one of ours
        /// (entry freed — the boundedness argument) from one that was already
        /// gone or never ours.
        Closed { server_id: u32, was_tracked: bool },
    }

    /// The click policy, PURE: no bus, no app handle, no window.
    ///
    /// This is the function that decides whether a desktop signal becomes an
    /// `attention-alert-clicked` event, so it is where the two rules that matter
    /// live — a body click echoes its OWN stored token and frees it, anything
    /// else echoes nothing.
    pub fn on_signal(signal: Signal) -> SignalOutcome {
        match signal {
            Signal::ActionInvoked { server_id, action } => {
                if action != DEFAULT_ACTION {
                    return SignalOutcome::OtherAction { server_id, action };
                }
                // Removing here (not merely reading) is what stops one banner
                // from navigating twice: the entry is gone the moment the click
                // is reported, so a second `ActionInvoked` for the same id —
                // which a server is free to send — lands as `Untracked`.
                match untrack_alert(server_id) {
                    Some(token) => SignalOutcome::Clicked { server_id, token },
                    None => SignalOutcome::Untracked { server_id },
                }
            }
            Signal::NotificationClosed { server_id } => SignalOutcome::Closed {
                server_id,
                was_tracked: untrack_alert(server_id).is_some(),
            },
        }
    }

    /// Narrow one bus message to a [`Signal`], or `None` for anything else.
    ///
    /// The match rule subscribes to everything the server emits on its path and
    /// interface (the plugin's own rule shape — one rule, dispatch on the member)
    /// because receiving BOTH members is what bounds the token map; so a third
    /// member can arrive and must be dropped here rather than mis-read.
    pub fn signal_of(message: &zbus::message::Message) -> Option<Signal> {
        // Bound, not chained: `member()` borrows the header, and the header is a
        // temporary that would die before the match on `&str` below.
        let header = message.header();
        let member = header.member()?.as_str();
        match member {
            "ActionInvoked" => {
                let (server_id, action) = message.body().deserialize::<(u32, String)>().ok()?;
                Some(Signal::ActionInvoked { server_id, action })
            }
            "NotificationClosed" => {
                // The second field is the close reason (1 dismissed by user,
                // 2 expired, 3 dismissed by call, 4 unspecified). Read and
                // discarded on purpose: the entry is freed for every reason, and
                // a stale alert must never click — see `on_signal`.
                let (server_id, _reason) = message.body().deserialize::<(u32, u32)>().ok()?;
                Some(Signal::NotificationClosed { server_id })
            }
            _ => None,
        }
    }

    /// Compose the alert exactly as it goes on the wire, WITHOUT sending it.
    ///
    /// Split out from [`session_bus_delivery`] so the actions list — the one part
    /// of the payload nothing else cross-checks — is assertable with no server.
    /// A `default` action missing from that list does not fail a test, it makes
    /// the whole feature silent, which is why it is pinned here as data.
    ///
    /// `pub` for that test; nothing else builds a notification by hand.
    pub fn alert_payload(text: &AlertText) -> notify_rust::Notification {
        // The notification the plugin builds on this platform and nothing more:
        // the same app name (`notify_rust`'s default, the executable's), the same
        // `auto_icon`, no hints, the server's own timeout. Moving off the plugin
        // must not change WHICH app the desktop resolves the alert to — that
        // resolution is the difference between a banner and silence (ADR 0038).
        let mut notification = notify_rust::Notification::new();
        notification.summary(&text.title);
        notification.body(&text.body);
        notification.auto_icon();
        // NOT `Notification::actions(vec![…])`, which would set the same two
        // strings: that method is `#[deprecated]`, and this crate's bar is
        // `cargo clippy --all-targets` at 0 warnings, so it would redden the gate
        // for no gain. `action(id, label)` pushes exactly the id/label PAIR the
        // spec sends, and on a fresh `Notification` the list starts empty — so
        // this call alone produces the contract's `["default", ""]`.
        notification.action(DEFAULT_ACTION, "");
        notification
    }

    /// Send one alert on the process-lifetime connection.
    ///
    /// `pub` ONLY so the ignored manual checks and the headless seam test can
    /// reach the real thing; production reaches this through [`production`]'s
    /// closure and nothing else.
    ///
    /// The send BLOCKS for one D-Bus round trip on the calling thread — which is
    /// what `notify_rust`'s `show()` already did, and what the plugin's spawned
    /// task did before that. This task's next and only remaining act is the log
    /// line, and the countdown that called us is a tokio task on its own worker,
    /// so nothing the user waits on is delayed by it.
    pub fn session_bus_delivery(text: &AlertText) -> Outcome {
        let notification = alert_payload(text);
        let (destination, path, interface) = BUS;
        // `auto_icon()` sets no hint and nothing else here does, so the hint set
        // is EMPTY — an empty map is the faithful payload, not a shortcut. (The
        // plugin filters its one `SoundName` hint into `("sound-name", …)`; we
        // send no hint, so there is nothing to filter and no conversion to
        // hand-build.)
        let hints = std::collections::HashMap::<&str, zbus::zvariant::Value>::new();

        let Some(connection) = connection() else {
            return Outcome::Refused("no session bus connection".into());
        };
        // The `Notify` call, tuple for tuple what the plugin's own `notify()`
        // sends: app name, replaced id 0, icon, summary, body, actions, hints,
        // timeout -1 (the server's own).
        let reply = match connection.call_method(
            Some(destination),
            path,
            Some(interface),
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
        ) {
            Ok(reply) => reply,
            Err(e) => return Outcome::Refused(e.to_string()),
        };

        // Type-annotated rather than `deserialize::<u32>()`, matching the
        // plugin's own `notify()` — the type is the fact under review here: it is
        // the wire type of the server's id, and therefore the key type of
        // `TOKENS`. A `u32` id and a `String` token, and nothing else is kept:
        // the token is stored, never read on this path.
        let id: u32 = match reply.body().deserialize() {
            Ok(id) => id,
            Err(e) => return Outcome::Refused(e.to_string()),
        };
        track_alert(id, text.click_token.clone());
        Outcome::Accepted { id }
    }

    /// Get the process-lifetime connection, opening it on first use.
    ///
    /// `None` only when there is no session bus to reach (a headless box, ssh
    /// without a bus address) — which is a refusal the caller logs, not a panic.
    fn connection() -> Option<zbus::blocking::Connection> {
        let mut slot = CONNECTION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.is_none() {
            match zbus::blocking::Connection::session() {
                Ok(connection) => {
                    *slot = Some(connection);
                }
                // No bus: nothing to subscribe to either, so this stays `None`
                // and every later alert is refused the same way. Logged because
                // "no alert arrived" is THE support question this feature has,
                // and this is a fourth cause nobody would think to look for.
                Err(e) => {
                    debuglog::log(&format!(
                        "attention: no session bus connection could be opened ({e}) — \
                         the alert cannot be sent"
                    ));
                    return None;
                }
            }
        }
        // `Clone` is an `Arc` clone: cheap, and it is what lets the caller hold a
        // connection without holding the lock.
        slot.clone()
    }

    /// The one signal thread, started the FIRST time a connection is opened.
    ///
    /// Lazily, with the connection: a thread that subscribed at startup would sit
    /// idle on a bus that may never be needed, and on a machine with no bus it
    /// would fail before there was an alert to blame it for. The thread keeps its
    /// own `Connection` clone alive for the process lifetime, which is what keeps
    /// the subscription (and the app's bus name) up — the very thing the per-alert
    /// connection used to fail to do.
    ///
    /// At most one thread ever runs, guarded by [`SIGNAL_THREAD_STARTED`]: the
    /// delivery closure runs per alert and would otherwise spawn one listener per
    /// alert, each with its own subscription and each emitting the same click.
    fn start_signal_thread<R: tauri::Runtime>(
        app: tauri::AppHandle<R>,
        connection: &zbus::blocking::Connection,
    ) {
        let mut started = SIGNAL_THREAD_STARTED
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *started {
            return;
        }
        match subscribe(connection) {
            Some(signals) => {
                match std::thread::Builder::new()
                    .name("attention-notifications".into())
                    .spawn(move || watch(signals, app))
                {
                    Ok(_) => *started = true,
                    Err(e) => debuglog::log(&format!(
                        "attention: the notification signal thread could not be started \
                         ({e}) — an alert that is clicked will not navigate"
                    )),
                }
            }
            None => debuglog::log(
                "attention: the notification signal subscription could not be opened — an \
                 alert that is clicked will not navigate",
            ),
        }
    }

    /// Subscribe to the notification server's signals on `connection`, or `None`
    /// when the rule or the subscription could not be set up.
    ///
    /// A helper rather than inline at the call site because its failure has to be
    /// distinguishable from "the thread would not spawn", and the two need
    /// different log lines — see [`start_signal_thread`].
    ///
    /// ONE rule, no member filter, dispatch on the member in [`signal_of`]:
    /// receiving `ActionInvoked` WITHOUT `NotificationClosed` would make the token
    /// map grow for the life of the process, and two rules would mean two
    /// subscriptions to keep in step for no gain. The plugin's own `listen()` uses
    /// this same shape.
    fn subscribe(
        connection: &zbus::blocking::Connection,
    ) -> Option<zbus::blocking::MessageIterator> {
        let (_, path, interface) = BUS;
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .path(path)
            .ok()?
            .interface(interface)
            .ok()?
            .build();
        zbus::blocking::MessageIterator::for_match_rule(rule, connection, None).ok()
    }

    /// The signal thread's loop: every signal the server emits, narrowed to a
    /// [`Signal`], decided by [`on_signal`], and emitted as an
    /// `attention-alert-clicked` event when — and only when — it was a body click
    /// on an alert this process sent.
    fn watch<R: tauri::Runtime>(
        signals: zbus::blocking::MessageIterator,
        app: tauri::AppHandle<R>,
    ) {
        // `flatten` drops a read error and keeps listening: one bad message (or
        // one interrupted read) must not be able to make the app permanently
        // deaf, and there is no one to retry against.
        for signal in signals.flatten() {
            let Some(signal) = signal_of(&signal) else {
                continue;
            };
            match on_signal(signal) {
                SignalOutcome::Clicked { server_id, token } => {
                    // The token goes back out EXACTLY as it arrived: no trim, no
                    // cap, no parse, no validation. Rust holds a string it cannot
                    // read and hands it back (ADR 0039).
                    debuglog::log(&format!(
                        "attention: alert CLICKED (id={server_id}) — emitting \
                         attention-alert-clicked"
                    ));
                    let _ = app.emit(
                        "attention-alert-clicked",
                        serde_json::json!({ "token": token }),
                    );
                }
                SignalOutcome::OtherAction { server_id, action } => {
                    debuglog::log(&format!(
                        "attention: alert action {action:?} on id={server_id} is not the body \
                         click — nothing emitted"
                    ));
                }
                SignalOutcome::Untracked { server_id } => {
                    debuglog::log(&format!(
                        "attention: signal for alert id={server_id}, which this process never \
                         sent (or no longer holds) — nothing emitted"
                    ));
                }
                // A close is the map's housekeeping and nothing the user is told
                // about: it fires for every alert that expires or is dismissed,
                // and a line per alert would bury the ones that carry meaning.
                SignalOutcome::Closed { .. } => {}
            }
        }
        // The iterator ends only when the connection dies, which for a
        // process-lifetime connection means the process is going away.
        debuglog::log("attention: the notification signal thread ended");
    }

    /// Whether the signal thread is up. A `Mutex<bool>` rather than a `Once`
    /// because the property wanted is "at most one thread is running", not "this
    /// code has been reached": a `Once` would spend its one shot on a FIRST
    /// attempt that failed (no subscription, or `spawn` refused), and the app
    /// would then be permanently unable to see a click it could perfectly well
    /// have subscribed for on the next alert. The flag is set only on a thread
    /// that actually started, so a failed attempt leaves the next alert free to
    /// try again — and an already-running thread is never duplicated.
    ///
    /// Held across [`subscribe`], which does one blocking D-Bus round trip: the
    /// countdown delivers one alert at a time (ADR 0038), so there is nothing to
    /// contend with, and the alternative — releasing before the spawn — would let
    /// two alerts both see `false` and both spawn.
    static SIGNAL_THREAD_STARTED: std::sync::Mutex<bool> = std::sync::Mutex::new(false);

    /// The [`Delivery`] for the session-bus desktops.
    ///
    /// Unlike the plugin's, this `production` DOES use its `AppHandle`: the
    /// signal thread emits on it when a click arrives. It is captured once here,
    /// at startup, and the thread keeps that clone for the process lifetime —
    /// which is also why the closure stays `Fn` with no per-alert setup.
    pub fn production<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Delivery {
        // The thread needs an `AppHandle` it can emit on and that outlives the
        // closure, so it holds a clone of the app's own.
        let app = app.clone();
        Arc::new(move |text: &AlertText| {
            let outcome = session_bus_delivery(text);
            // The thread comes up alongside the connection it subscribes on, and
            // only once (see `start_signal_thread`). Deliberately AFTER the send:
            // a subscription that fails must not cost the user the alert, and the
            // click of THIS alert can only arrive after a human reads it, which is
            // later than the line below regardless.
            if let Some(connection) = connection() {
                start_signal_thread(app.clone(), &connection);
            }
            debuglog::log(&super::delivery_trace(&outcome));
        })
    }
}

// The doc lives INSIDE the module (`//!`), matching the sibling `bus` module:
// an outer `///` on a `mod` whose body opens with `//!` is `mixed_attributes_style`,
// which is a hard error under the AGENTS.md `-D warnings`, and this module only
// compiles on macOS/Windows — so the Linux bar that ran here could not see it.
#[cfg(not(all(
    unix,
    not(any(target_os = "macos", target_os = "android", target_os = "ios"))
)))]
pub mod plugin {
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
}

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
}
