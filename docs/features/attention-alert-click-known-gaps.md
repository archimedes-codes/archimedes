---
status: live
last-verified: 2026-11-11
verified-by: re-measured at the merge of PR #184 (`cad9f5ab`) rather than copied from the plan — `grep -rnE '^\s+[a-z]+_[a-z]+:' src/lib/*.ts | grep -v '\.test\.' | grep -v toolOutput.ts` gives **exactly 1** hit (`attention.ts` `click_token`), the toolOutput hits are TOOL-NAME keys not fields; `grep -n "attention" src-tauri/tests/ipc.rs` registers **only** `attention_disarm`; `bash scripts/check-commands.sh` prints **71 registered / 70 consumed, both directions agree** and its scan reads the first argument of each `invoke` as a NAME and drops payload keys, so it cannot see an argument rename; `grep -rn "initialTopMostItemIndex" src/` gives the prop at `MessageList.tsx:630`, prose at `MessageList.scroll.test.tsx:947`, and a **strip** at `src/test/setup.tsx:8`, i.e. no assertion; `cargo test --test attention_alert_click -- --list` gives **15 tests**; `ls docs/decisions/ | grep -oE '^[0-9]{4}' | sort | uniq -d` still prints only the known `0086`
---

# Attention alert click-to-navigate — known gaps

Accepted, unfixed defects and deliberately-unbuilt scope in the **Alert click** route: the opaque
**Click token** that rides an **Attention alert**, the one process-lifetime D-Bus connection that
sends it and listens for its click, the `attention-alert-clicked` event, the `raise_attention_window`
command, and the transcript jump to the bottom. They live here because the roadmap family that
recorded them (`docs/roadmap/attention-alert-click-to-navigate*.md`) is deleted on ship,
`docs/roadmap/` is gitignored, and nothing in it is recoverable afterwards — no `git checkout`, no
stash, no dangling blob. This is the surviving home. Read it before concluding that a raise, a
click, or a wire name is verified.

The design is ADR 0103 (one connection, opaque token, the `Retained` cap-8 deletion) which amends
ADR 0038's retention paragraph; the Session-vocabulary boundary it preserves is ADR 0039; the
reported behaviour is [issue #177](https://github.com/archimedes-codes/archimedes/issues/177) and
the spec survives as the `spec` artifact on that board card. Shipped as PR #184. This file holds
only what is still open.

## 1. The window raise is best-effort, and for a MINIMIZED window it provably cannot work on Linux

Two separate reasons, and the second one is the load-bearing one.

**No activation token exists.** No `ActivationToken` is emitted at any layer on the reporter's
desktop (niri + quickshell + XWayland — quickshell's fix is an unmerged upstream PR), and the app is
GTK3, so it runs under XWayland, where `tao`'s `set_focus()` is
`gtk_window_present_with_time(GDK_CURRENT_TIME)`. So catching the click is provable while surfacing
the window is not, and the design splits its guarantee accordingly: **navigation is the guaranteed
half, the raise is narrated, not proven.**

**And the order is necessary but not sufficient.** `unminimize() → show() → set_focus()` is
load-bearing because tao's Linux `set_focus()` is guarded by `!minimized && visible` and otherwise
silently no-ops — but for a minimized window no synchronous call can satisfy it. `set_minimized`
only ENQUEUES `WindowRequest::Minimized(false)` onto a `glib::MainContext` channel (tao 0.37.1
`platform_impl/linux/window.rs:623`, `event_loop.rs:244`), so `deiconify()` runs on a later GLib
drain, while `set_focus` (`window.rs:582`) reads the `minimized` `AtomicBool` **synchronously** and
that flag is written only by the GTK `window-state-event` handler (`window.rs:372`), which needs a
drain of its own. `raise_attention_window` is a **sync** `#[tauri::command]`, which Tauri runs inline
on the main thread inside the IPC callback, so nothing drains between step 1 and step 3: a minimized
window's `set_focus()` sees `minimized == true`, takes its silent no-op branch, and **its log line
still narrates `focused`**. The visible-but-unfocused case — the common one — is unaffected, the flag
is already `false`, `Focus` is enqueued and the order does its job.

*Candidate fix, deliberately not implemented:* defer the `set_focus()` to a later GLib turn so the
un-minimize drain has landed. Out of scope for a feature that scoped the raise as best-effort.

**Never describe a raise as behaviourally verified from a Linux box.**
`cargo check --target x86_64-pc-windows-gnu --all-targets` TYPE-CHECKS the plugin half, the msvc
target needs `lib.exe`, there is no wine and no macOS host here, and no check in this repository
drives a real compositor or window manager. The pins (`raise_trace`'s unit tests plus the raise group
in `tests/attention_alert_click.rs`) prove the CALLS and their narration order, never the RESULT.

## 2. The GNOME teardown is made impossible by construction, which is an argument and not a measurement

ADR 0038 measured alerts vanishing 22–25 ms after `Notify` was answered, because the Shell's FDO
daemon name-watches the sender and `_onNameVanished` ends in `if (this.app) this.destroy()`. ADR 0103
replaces the per-alert connection with one for the process lifetime, which removes the per-alert bus
name — so the teardown has nothing to watch and is **structurally impossible rather than mitigated**.

That reasoning has not been re-measured: the reporter's shell is quickshell, not GNOME. It needs a
GNOME host or a D-Bus capture to become evidence. The `Retained`/`RETAINED_ALERT_CAP` machinery is
deleted, not bypassed, so if the argument is wrong there is no cap left behind to catch it.

## 3. macOS may park one thread per alert — the highest-value unverified item here

Registering `on_action` makes the plugin's `has_listeners()` true, which moves every notification onto
`show_tracked` → a thread calling `wait_for_response` → `send_mac_notification(asynchronous: false)`,
documented as blocking indefinitely. That is a per-alert leak in a process that runs for weeks, on the
platform where alerts are most used. It is pinned by an ignored manual check, **not asserted**. The
`on_action` handler is registered ONCE in `production()` for a different reason — registering per
alert would multiply one click by the number of alerts sent, because `on_action` appends to a handler
list — so the fix is not obvious and needs a real macOS run.

## 4. A one-sided rename of the click contract is green on every local gate

`src-tauri/tests/ipc.rs` keeps its OWN `generate_handler!` list and registers only `attention_disarm`
— deliberately, because arming would start a real countdown. So the IPC harness never sees
`attention_arm`'s fourth argument. Consequences, all re-confirmed:

- `scripts/check-commands.sh` reports **71 registered / 70 consumed, both directions agree**, but its
  scan reads the first argument of each `invoke` as a command NAME and explicitly drops payload keys —
  it cannot see `clickToken` → `click_token` drifting, nor the `attention-alert-clicked` event name.
- No event-parity test may be added: `src/lib/ipc/events.ts` documents that grepping
  `src-tauri/src` for `emit(` and requiring a constant is UNSOUND (several names have no native
  emitter, and names flow dynamically through the sink).

So the contract — `clickToken` ↔ `click_token`, event `attention-alert-clicked`, payload
`{ token }`, command `raise_attention_window`, D-Bus actions `["default", ""]`, plugin extra key
`attentionToken` with `action_id() == "tap"` — is held only by each side pinning its own spelling
literally. Closing the asymmetry means registering a NON-arming arm path on the Rust side, which is
new scope, not a leftover.

## 5. `attentionAlertText` returns `click_token` — snake_case in a JS pure module

The wire key is `clickToken` (correct, matching Rust's `click_token`), but the RETURN FIELD of the
renderer's pure function is `click_token`. It is the only underscore-named field in `src/lib/` outside
wire shapes and tool-name maps: the grep in the front matter gives exactly one hit once
`toolOutput.ts`'s tool-name keys are excluded. One call site destructures it
(`useAttentionAlert.ts`), so a rename is a 3-file mechanical change (`attention.ts`,
`attention.test.ts`, `useAttentionAlert.ts`) with no wire impact. Not fixed in the ship PR because a
naming churn beside a behaviour change makes both harder to read.

## 6. The stored-Session click's scroll comes from Virtuoso's mount prop, not from the focus effect

The listener runs outside React, so `openSession`'s history page has not landed when the click
arrives and a stored Session's first frame is the `units.length === 0` branch. That branch
**consumes-and-clears** the request instead of scrolling — correct, because nothing is scrollable
there and a request that survived the frame would be replayed by a later, unrelated mount.

The guarantee that the next frame lands at the bottom therefore rests on `TranscriptScroller` mounting
with `initialTopMostItemIndex={{ index: "LAST", align: "end" }}` (`MessageList.tsx:630`), not on
`handleScrollToBottom`. Two things make that fragile:

- Nothing asserts the mount prop. `grep -rn "initialTopMostItemIndex" src/` finds it at the call site,
  in prose at `MessageList.scroll.test.tsx:947`, and **stripped** at `src/test/setup.tsx:8` (the jsdom
  setup removes it because real Virtuoso renders 0 rows synchronously with it). So removing the prop
  would not redden a single test, and this path would silently stop scrolling.
- The empty-branch consume IS pinned — "the EMPTY branch drains a matching request without
  scrolling (a stored session's first frame)" and "the EMPTY branch leaves a request for another
  session pending" in `src/components/chat/MessageList.scroll.test.tsx`. Those pins say the request
  is DROPPED; they cannot say the next frame scrolls, because there is no next frame in that test.

A `focusRequest`-aware assertion on the mount path is the cheap pin. It is not written here because
the jsdom setup deliberately strips the very prop such an assertion would read.

## 7. Manual checks a human must run (each NAMES the half it proves)

```bash
# At a desktop session — not CI, not ssh. Proves the connection half, then the click half.
cargo test --test attention_alert_survives -- --ignored --nocapture
```

Plus the macOS parked-thread check ADR 0103 names (§3 above). The bus-capture recipe
(`busctl --user monitor org.freedesktop.Notifications`) is in that test file's module doc.

## 8. Resolved, recorded so nobody re-files it

`src/lib/tauriBarrel.test.ts` once cited "issue #177" for *Task interaction* — a dangling reference
that became a confidently wrong one the moment #177 was opened for this notification work. It was
corrected to `Task interaction (PR #178)` before this ship, and `grep -rn "#177" src/` prints
nothing. The card's note about it is stale.
