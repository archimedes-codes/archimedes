---
status: accepted
date: 2026-11-11
superseded-by:
---

# One process-lifetime notification connection, and an opaque click token beside the alert text

Clicking the body of an **Attention alert** has to select whatever raised it. That needs two things
this app did not have: a way to see the click at all, and something to identify with. We decided
(1) **one `zbus` session-bus connection, opened with the first alert and held for the life of the
process**, replaces the per-alert connection `notify_rust::Notification::show()` used to open, and
(2) the renderer sends an **opaque `click_token`** beside the alert's text, which Rust stores as
`server notification id → token` and echoes back VERBATIM on `attention-alert-clicked` when the
desktop reports the alert was clicked.

The consequence people will want to argue with is the first one's second half: **the
`Retained`/`RETAINED_ALERT_CAP` machinery is deleted, not bypassed.** ADR 0038 recorded that store
as load-bearing, and it was — for the design that had one connection per alert. The cap existed
solely to bound a count of per-alert connections; with one connection there is nothing to count,
nothing to evict, and an eviction that evicts nothing still needs no log line. ADR 0038's retention
paragraph is amended to say so rather than left describing a data structure that no longer exists.

## Why the transport had to change, not just gain a listener

The teardown ADR 0038 measured is a rule about the DESKTOP, not about us: the Shell's FDO daemon
name-watches the sender of a notification and its `_onNameVanished` handler ends in
`if (this.app) this.destroy()`, which is how an alert vanished 22–25 ms after `Notify` was answered.
The old answer was to keep the handle that owns the connection, capped at eight.

Watching for a click forces the same change from the other side. A body click is a signal
(`ActionInvoked`) on the notification server's interface, and some servers — `dunst` is the one named
in the plugin's own source — send a notification's signals **only to the connection that sent it**.
So a click listener must live on the connection the alert was sent on. Per-alert connections would
mean a per-alert signal subscription, or a subscription on one connection that cannot see the
others' clicks. One connection is the only shape where the send and the listener can both work, and
once there is one connection the per-alert bus name — the thing GNOME watched vanish — stops
existing. The mitigation becomes structurally impossible rather than mitigated.

That is the argument. It is a DESIGN argument and it stays one on this machine: **the teardown has
not been re-measured here.** ADR 0038's 22–25 ms figure came from GNOME 50.5; the reporter's shell
is quickshell, not GNOME, so the "now impossible" claim is reasoned, not observed. The two
`#[ignore]`d checks in `src-tauri/tests/attention_alert_survives.rs` are what a person runs to look
at it, and each one now says which half it proves — the connection-survival half, or the
click-arrival half.

## The token keeps ADR 0039 intact, and the boundary is the whole point

ADR 0039 says the renderer owns the Session vocabulary and Rust owns the clock. Handing Rust a
Session id looks like a dent in that, so the shape is deliberately minimal: Rust **stores one string
and hands it back**. It never parses, trims, caps, validates, compares or logs the token, and it has
no way to interpret one — the Supervisor holds a string it cannot read.

Where the token is *not* passed is load-bearing. `commands::attention::alert_text` is the function
that trims, caps title/body, and refuses a body that trims to nothing; it has **no parameter for a
token** and returns an `AlertText` whose `click_token` is empty, for the command to overwrite. Three
defects are prevented by that one absence: a token truncated by the body's char cap, a token padded
away by the trim, and — the one that would have killed the feature silently — an **empty token
refused** by a rule that exists because an empty *body* means the renderer composed nothing. An
empty token is legal and clickable. Pinned by
`the_text_boundary_never_sees_or_invents_a_click_token`.

The token reaches the countdown as an `arm` argument and rides inside `AlertText`, so the `Delivery`
seam keeps its `Fn(&AlertText)` signature — the timer must not branch on what delivery learned, and
a token that arrived as a fifth parameter to the delivery closure would have made the seam know more
than it is allowed to. It travels with its OWN arming: a countdown that loses the pending slot takes
its token down with it, so an alert can never echo the id of the pause it replaced.

## The facts worth not re-deriving

**A body click is unobservable unless the alert declares the `default` action.** The Desktop
Notifications Specification sends actions as id/label pairs, and a click on the notification itself
is reported as `ActionInvoked(id, "default")` — which a server only offers if `default` was
declared. The list is therefore EXACTLY `["default", ""]`: the id that makes the click observable,
and an **empty label** so no button is rendered for the user to reason about. Pinned as a literal in
`the_alert_declares_exactly_the_default_action_and_nothing_else`, because a wrong pair fails no
assertion on either side of the wire — it just makes the feature silent.

**`notify_rust`'s `Notification::actions(Vec<String>)` is `#[deprecated]`.** Use
`notification.action("default", "")`, which pushes exactly those two strings onto a fresh
notification's empty list. Same wire bytes; `cargo clippy --all-targets` runs at 0 warnings in this
repo, so the deprecated call would redden the gate for no gain.

**The token map is bounded by OUTSTANDING alerts, not by the process lifetime.** `ActionInvoked`
removes the entry (so one banner cannot navigate twice) and `NotificationClosed` removes it (so every
dismissal and expiry frees it). That is the replacement for the cap: not a smaller cap, a structure
the server itself drains. The key is a `u32` DELIBERATELY — the wire type of both the `Notify` reply
and the first field of both signals. `tauri-plugin-notification`'s own tracker keys an `i32`, and
that is a different number for a different purpose (its own monotonic notification identifier, held
*under* a `u32` server id); the two must not be "unified".

**On macOS and Windows the token rides the plugin's `extra` and the click arrives as
`action_id() == "tap"`.** `.extra("attentionToken", …)` on the builder, read back off
`ActionPerformed::notification()?.extra()`, with `on_action` registered ONCE in `production()` —
registering per alert would multiply one click by the number of alerts sent, because `on_action`
appends to a handler list.

**The raise order is `unminimize() → show() → set_focus()`, and never focus-first.** tao's Linux
`set_focus()` is guarded by `!minimized && visible` and otherwise silently no-ops, so focusing a
minimized window does nothing at all and reports success doing it — the worst failure this feature
can have, because it is silent. `show()` precedes the focus for the same reason on a hidden window.
The order is therefore load-bearing, and it lives in one pure function,
`commands::window_state::raise_trace`, in the `focus_probe_trace` / `webview_focus_trace` shape: the
three raw outcomes come in as data and it returns (was there a window at all, the lines for the
debug log). The thin `raise_attention_window` command resolves `get_webview_window("main")`, makes
all three calls, and writes exactly one `debuglog` line per step — success narrated, refusal named
with its own `Display` — under the `attention: raise: ` prefix. A refusal of step N does **not** skip
step N+1: `unminimize()` on a window that is already un-minimized is a no-op or an error depending on
the platform, and the two calls that could still bring the window forward must not be lost for it.
The command answers `Ok(())` on every path including the no-window path — the raise is best-effort,
the click already happened, and the renderer has nothing it could do with a refusal; the log is where
the failure lands.

**That order is necessary and NOT sufficient, for a minimized window on Linux** — recorded because
three narrated `attention: raise: ` lines otherwise read as proof the window came forward. tao 0.37.1
enqueues rather than acts: `set_minimized` (`platform_impl/linux/window.rs:623`) pushes
`WindowRequest::Minimized(false)` onto a `glib::MainContext` channel (`event_loop.rs:244`) and the
`deiconify()` only runs when the GLib main loop drains it, while `set_focus` (`window.rs:582`) reads
the `minimized` `AtomicBool` **synchronously** — and that flag is written only by the GTK
`window-state-event` handler (`window.rs:372`), which needs a drain of its own.
`raise_attention_window` is a **sync** `#[tauri::command]`, which Tauri runs inline on the main
thread inside the IPC callback, so the channel cannot drain between step 1 and step 3. Hence: for a
**visible-but-unfocused** window (the common case) `minimized` is already `false`, `get_visible()` is
true, `Focus` is enqueued and the order does its job; for a **minimized** window `minimized` is still
`true` at step 3 and `set_focus()` takes its silent no-op branch. The candidate fix is a follow-up
turn — defer the `set_focus()` to a later GLib turn, after the drain — and it is deliberately NOT
implemented: this ADR scopes the raise as best-effort and the navigation as the guaranteed half, so
machinery to chase one window state is out of scope.

**What that makes true, and what it does not.** The order and the wording are now implemented and
pinned by `raise_trace`'s unit tests plus the raise group in `tests/attention_alert_click.rs` —
three narrated lines in order, a refused `unminimize` getting its own line while the later two still
produce theirs (the no-early-return claim), and one line for a missing window that names the label it
looked for. That is the whole of what a headless checkout can prove, and it pins the CALLS, never the
RESULT. **The raise is NOT behaviourally verified on Windows or under Wayland.**
`cargo check --target x86_64-pc-windows-gnu --all-targets` TYPE-CHECKS that target (the msvc target
needs `lib.exe`, and there is no wine here), there is no macOS host, and no check in this repository
drives a real compositor or window manager. Whether an alert click actually surfaces a window on those
platforms is a measurement someone has to make on one.

## Considered Options

- **Keep `Retained`, add a signal thread alongside it.** Least deleted code, and incoherent: it
  retains per-alert connections whose alerts were sent on connections no listener can see, so the
  click half would need a second transport anyway — two mechanisms where one subsumes the other.
- **Emit the click with the token read back from the notification payload rather than our own map.**
  The XDG `ActionInvoked` signal carries only `(id, action)` — no payload — so a map is the only way
  to get from the server's id to the renderer's token on this platform. The plugin solves the same
  problem with the same structure (`Tracker::shown`), which is the precedent this follows.
- **Cap the map instead of draining it on close.** Rejected: the close signal arrives, so a cap
  would pay eviction (dropping the click of an alert that is genuinely still up) to bound something
  that is already bounded.
- **Let the plugin send the alert on Linux and only listen ourselves.** The plugin drops the handle
  that owns its connection — that is the behaviour ADR 0038 measured. Our own send is what makes the
  sender stable, and it is the plugin's own `notify()` tuple copied tuple for tuple, so the payload
  is not a new invention.

## Consequences

`zbus` becomes a direct dependency of this crate, under the same Linux/BSD target gate as
`notify-rust`, with no feature added — `blocking-api` is in zbus's default features and 5.19.0 was
already resolved in `Cargo.lock` via the plugin's own dependency on it, so the lockfile gains one
line in the `archimedes` dependency list and compiles nothing new. The blocking API is used because
that is the plugin's shape and it needs no runtime context on the delivery path.

`Outcome::Accepted` loses its `released` field and the success log line loses its retain-cap
sentence; `the_accepted_line_never_mentions_a_released_alert` is the replacement claim. Three
`Retained` unit tests are deleted with zero coverage loss beyond them — the deletion is proved on
the leaf-unique test-name set, and the two things they used to guarantee (boundedness, and wording
that cannot claim an eviction) are now pinned by `tests/attention_alert_click.rs` and by the new
accepted-line test.

The connection is opened lazily, on the first alert, and the signal thread starts with it — not at
startup, where it would sit on a bus that may never be needed and would fail on a machine with no
bus before there was an alert to blame it for. Every failure on that path (no bus, no rule, no
subscription, no thread) is a `debuglog` line naming itself, because "no alert arrived" already has
three causes a D-Bus capture cannot separate and this feature adds a fourth: an alert that arrives
but cannot be clicked.

**Not verified, and recorded as a gap rather than a claim.** The `attention-alert-clicked` path on
macOS and Windows is TYPE-CHECKED and nothing more — `cargo check --target x86_64-pc-windows-gnu
--all-targets` compiles the `plugin` half, and there is no macOS or Windows host here. Two specific
unknowns: whether `on_action` making the plugin's `has_listeners()` true moves macOS onto its
per-alert tracked-notification thread path, and the exact `actionPerformed` payload casing beyond the
`.extra()` getter we read. Both need a real macOS run, which no check in this repository performs.
