---
status: accepted
date: 2026-10-12
superseded-by:
---

# Attention alerts fire only while the window is unfocused

An **Attention alert** whose delay elapses while the Archimedes window is the
focused window is dropped silently and never retried — the alert exists to reach a
user who has left, and a toast landing on top of the window they are reading is
noise. pi-archimedes' own `notify` package does the opposite on purpose ("no focus
tracking. Keystrokes are the only signal"), because a terminal cannot tell whether
the user is looking; the desktop can, so it uses that fact instead of mimicking the
terminal's blind spot. The one-shot half is the deliberate part: holding a fired-but
-suppressed alert until the next blur would let a Session that settled an hour ago
ring when the user finally alt-tabs, which is pi's own "a long-gone question cannot
ring" failure in new clothes.

## Considered Options

- Fire regardless of focus (the faithful port) — rejected: fires over the frontmost
  window, which is the one window the user is demonstrably reading.
- Hold the suppressed alert and fire it on the next blur — rejected: needs an expiry
  to avoid stale alerts, and re-introduces the delayed nag it was meant to avoid.
- Make focus-suppression a third setting — rejected: a knob for behaviour whose
  only alternative is worse on every platform (macOS suppresses frontmost-app
  notifications at the OS level anyway).

## Consequences

**The common case is the dropped one.** The likeliest real sequence is: watch a
run finish in the window, then walk away within the delay. The countdown expires
while the window still holds focus, so the alert is dropped and that pause never
announces itself at all. This is the decision above applied honestly, not an
oversight — holding the alert for the next blur is the rejected alternative, and
a user who was looking when the run finished has already seen it finish. "Alerts
when a Session has been paused on you" therefore means "…when you were already
gone by the time the delay expired", and nothing short of an expiry-hold (which
re-introduces the stale nag) covers the walk-away-after-finish pattern.

**The drop is WINDOW-level while a pause is SESSION-level, so its scope is wider
than "the run you were watching".** Focus is one answer about one window
(`WebviewWindow::is_focused()` on the main window, `src-tauri/src/lib.rs:145-149`),
while a pause belongs to a Session. So with the window focused on Session A, a gate
that opens in a background Session — or in a **Subagent session** — is dropped at
expiry exactly the same, and that user has demonstrably NOT seen it: `ChatStream`
renders gates for the active Session only (`src/components/ChatStream.tsx:103-112`
selects `prompts` and `requests` by `activeSessionId`). It is survivable through the
in-app affordance rather than through the alert: a waiting Session is marked in the
sidebar list with its "Waiting" pill (`src/components/SpacesList.tsx:552-559`), and
the collapsed rail marks it with the warning-fill dot and carries a waiting count in
its accessible name (`src/components/SessionRail.tsx:102-107` and `:180-191`). Closing
the gap itself would need a per-Session notion of "seen", which the app does not
have; this paragraph exists to keep the decision above from being read as narrower
than it is.

> **Amended 2026-10-16 (the `?` mark).** The two affordances named above are now ONE
> glyph: `SessionStatusMark` (`src/components/SessionStatusMark.tsx`) draws a `?` in
> the attention ink in the session row's leading slot — the slot the spinner occupies
> — and the same glyph in the rail and in the Space's tab. The row's text "Waiting"
> pill is gone (it hid the row's relative time while a Session waited, and it was the
> rail's dot restated in a second shape). The argument in this paragraph is unchanged:
> the cue still exists in the open list, the collapsed rail, AND the tab bar, and the
> rail's accessible name still carries the waiting count.

**One alert per pause is per renderer session, not per pause** (and which pause owns
the single countdown when several are owed at once is ADR 0040). The record of which
pauses have been announced lives in the renderer's memory (ADR 0039 — Rust is handed
a delay and some text and never learns what a pause is), and a webview reload wipes
it. Half of what that implies is closed: a reload runs no React cleanup, so a
countdown armed before it would otherwise survive, fire with stale text, and be
uncancellable from a page whose memory starts unarmed — hence the hook disarms
unconditionally on mount, declared above the pass effect so boot is disarm-then-arm.
The mirror image is not closable renderer-side and is accepted: the same reload
forgets the announced set, so a question that already alerted **alerts again**.
Fixing it properly means the Supervisor owning the announced set, or persisting it —
something to pick up deliberately, not to rediscover as a surprise.

**Activity signals can never be the reason a focused alert is suppressed** — input
arrives with focus, so the two gates overlap almost entirely. They remain
load-bearing anyway: they stop an armed alert from ringing for a pause the user
already resolved inside the delay (came back, typed, left again), and — with the
`beginTurn` disarm — from announcing "finished" while a turn they just started is
still streaming.

## How a Linux alert survives the desktop

ADR 0039 owns which transport each platform uses. What this section owns is the rule
the desktop imposes on an alert's lifetime, which is what took the Linux transport off
the notification plugin and is now a constraint on this decision rather than an
implementation detail. Measured on GNOME Shell **50.5** (Fedora 44, Wayland).

**An alert's lifetime includes its sender.** GNOME's FDO daemon makes an alert's
*source* watch the SENDER'S BUS NAME
(`Gio.DBus.session.watch_name(sender, …, this._onNameVanished)`) and destroy that
source when the name disappears — `shell_notificationDaemon.js`, in
`resource:///org/gnome/shell/ui/messageList.js` +
`/usr/share/gnome-shell/js/ui/messageTray.js`:

```js
_onNameVanished(connection, name) {
    const source = this._notifyDaemons.get(name)?.source;
    if (!source) return;
    if (this._senderForNotification.has(name))
        source.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
}
```

So an alert whose sending connection has already closed is destroyed with reason
`DISMISSED` (2) — neither the user nor a timeout — 22–25 ms after the server answered
`Notify` (measured three times). Nothing is logged on the sender's side: no banner anyone
can read, no entry in the message list, no error. **Hence: whatever owns the connection
the alert was sent on is part of the alert.** This app's first answer was to keep the
handle the server answers with — `attention::delivery`'s `Retained` store held every
returned handle for the process lifetime, bounded at `RETAINED_ALERT_CAP = 8` and
evicting the OLDEST, bounded because unbounded retention is a connection leak in a
process that runs for weeks. **That store is gone, and the reason it is worth keeping
this paragraph to say so is that the rule above still holds.** `notify_rust`'s `show()`
opened one connection per alert, so eight alerts meant eight connections to count and
one to release; the release was therefore a deliberate re-exposure to the teardown,
which is why the old log line named it. The alert is now sent on **one session-bus
connection the process holds for its whole life** (`attention::delivery::bus`,
ADR 0103), so there is no per-alert bus name for the daemon to watch vanish, nothing to
count, and nothing to evict — the teardown is not mitigated here, it is structurally
impossible, and the same connection carries the one signal subscription that reports a
body click. The `#[ignore]`d `src-tauri/tests/attention_alert_survives.rs` no longer
reproduces the destruction (its dropped-handle half no longer has a shape to be dropped
into); its two checks now prove the halves of the new design — that an alert on the
long-lived connection is still tracked after three seconds, and that a click on it
arrives.

**The rule bites only senders the desktop resolves to an app, and it resolves us.**
The destroy sits behind `if (this.app)`, so a sender GNOME cannot attribute is exempt:
`notify-send` alerts survive a dead sender, and so do this crate's own test-binary
deliveries, which is why the bug read as a GNOME quirk. We are not such a sender, and
the chain that makes us one is why the feature is coupled to a desktop entry.
`enableGtkAppId` is never set, so Tauri hands GTK no app id — it passes
`Some(identifier)` only `if manager.config.app.enable_gtk_app_id` (`tauri` 2.12.2,
`src/app.rs:2446`; the default is `false`, `tauri-utils` 2.10.1 `src/config.rs:5035`)
— so GTK derives the id from `prgname` and the window's Wayland `app_id`/WM_CLASS is
the executable name, `archimedes`. `notify_rust` defaults a notification's `app_name`
to that same executable name (4.18.2, `src/notification.rs:24`, `:119`), and GNOME
looks that up as `<app_name>.desktop`, which `make install-desktop` installs as
`~/.local/share/applications/archimedes.desktop` with `StartupWMClass=archimedes`.
Attribution and survival are therefore the same fact: the entry that gives the alert
its name and icon is what makes `this.app` truthy and the destroy apply. Observed on
the installed AppImage on this box: a banner with the app's own icon, whose
`NotificationClosed` arrived 10.3 s later — a lifetime, not a teardown.

**"A Linux alert vanished seconds after appearing" means the sender's connection
closed, and only a D-Bus capture can say so.**
`dbus-monitor "interface='org.freedesktop.Notifications'"` sees both the calls and the
`NotificationClosed` signal, and `busctl --user status
org.freedesktop.Notifications` names the server — on GNOME, the Shell's own
`gjs -m /usr/share/gnome-shell/org.gnome.Shell.Notifications`.
`ps -e | grep -i notify` is a **false negative** there: it prints nothing
while the server runs, because the Shell holds the bus name and no process is named
"notify". Nothing inside the app can witness its own close either — the daemon emits
the signal AT a destination rather than broadcast (measured
`Sender=:1.17 Destination=:1.31`), which is why no `zbus` dependency was added and the
eavesdropper is the instrument.

**Attribution is the platform question tests cannot reach.** Windows attributes a
toast through an AUMID, which only an *installed* bundle registers, so a dev-build
Windows toast is mislabelled by design and only an installed-bundle run closes that
platform row (the plugin documents this; it has never been exercised here, or
anywhere).

## Amendment (2026-11-09) — one of the three surfaces that carried the cue is gone

ADR 0094 made both flanking panes permanent and deleted the collapsed **Session list** rail
with it. Two consequences for this decision, and neither changes its argument:

- **The rail and its warning-fill dot are gone.** The paragraph above that lists where the
  in-app cue lives named three surfaces — the open session list, the collapsed rail, AND the
  tab bar — and the 2026-10-16 amendment restated that count after the `?` mark unified the
  pill and the dot. It is now TWO surfaces: the session row's leading slot and the **Space**'s
  tab, both drawn by `SessionStatusMark`. The rail's waiting count in an accessible name went
  with the rail.
- **Two file:line citations in that paragraph are now historical.**
  `src/components/SessionRail.tsx` **no longer exists**, so neither of its two cited ranges
  (`:102-107` and `:180-191`) resolves to anything; and the `src/components/SpacesList.tsx`
  range cited for the "Waiting" pill no longer holds that pill, which the 2026-10-16 amendment
  above had already retired. Both are left in place rather than renumbered — this file is the
  record of what was true when the decision was taken, and the cue's *content* is cited here by
  name (`SessionStatusMark`, the row's leading slot, the tab) rather than by a new line number,
  because line numbers are exactly what this repo's docs keep losing.

**The argument is unchanged, and it gets slightly worse rather than better.** The paragraph
exists to stop this decision being read as narrower than it is: a gate that opens while the
window is focused elsewhere is dropped at expiry even though that user has demonstrably not seen
it, and the in-app affordance is what makes that survivable. One of the three surfaces carrying
that affordance has been removed, so the surviving two carry more weight than they did — the
row's `?` and the tab's `?`, both of which stay. Whether two is enough is a question about the
alert's scope, not about this amendment, and ADR 0040's ladder is untouched by it.

## Amendment (2026-11-09) — the exemption's scope is written down, and one of its neighbours moved

This note is **additive**: nothing below is a correction, because the exemption it records was
never stated in this ADR's body. The focus rule above says an alert is dropped while the window is
focused and says nothing about which *clicks* count as attention; that half of the contract lives
in code and in a test, not here — `src/hooks/useAttentionAlert.ts`'s
`if (el?.closest("[data-window-control]")) return;`, and `App.test.tsx`'s pin that the app controls
resolve outside `[data-window-control]`. Writing it down is the point, since the rule has been
cited from three different places and had no home.

- **The exempted surface is the window controls, and only the window controls.**
  `[data-window-control]` is `WindowControls`' container — Minimize / Maximize / Close, three
  buttons — and the exemption is scoped to that container rather than to the chrome bar, so a click
  on the drag bar, a **Space** tab, or any app control IS attention. The reason for the narrow scope
  is this ADR's own use case: "run finishes → click Minimize → walk away" must not self-cancel the
  alert it just earned, while a click that returns the user to work must disarm it. Anything added
  inside that container inherits the exemption, which is why the container's comment says to add one
  deliberately.
- **The Settings door moved and stayed outside the exemption.** It used to sit in the chrome bar's
  app-control cluster immediately inboard of the window controls — adjacent to the exemption but
  deliberately not inside it, because opening Settings is a person coming back to work. ADR 0095
  relocated that door into the **Session list**'s command strip, which is far from the window
  controls in every sense, so the property now holds **structurally** rather than by placement
  discipline. The `App.test.tsx` pin was kept anyway (re-titled to name the door rather than the
  retired cluster) on this ADR's own logic: an unasserted structural property is one refactor away
  from silently regressing, and the consequence of the regression is invisible — an alert that
  quietly stops firing for someone who just sat down.
- **No behaviour changed.** No click that used to count stopped counting, and none that used to be
  exempt started counting. The one thing that could have drifted is a relocated control landing
  inside the container by accident, and it did not.
