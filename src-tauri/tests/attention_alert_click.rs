//! The click half of an Attention alert, pinned with NO bus, NO window and NO
//! desktop: the id→token map, what each server signal does to it, the exact
//! actions list the alert is sent with, and the order of the raise a click calls.
//!
//! Clicking an alert's body must select the Session that raised it, and the only
//! thing Rust holds to make that happen is the string the renderer sent — the
//! already-resolved parent Session id, stored as `server id → token` and echoed
//! back VERBATIM on `attention-alert-clicked` (ADR 0039: Rust owns no Session
//! vocabulary, it holds one string it cannot read). Three things can break that,
//! and none of them needs a screen to prove:
//!
//!   * **the entry outlives the alert** — a leak, so the map grows for the life
//!     of a process that runs for weeks;
//!   * **the entry is never freed on a second click** — the same alert navigates
//!     twice;
//!   * **the actions list is wrong** — without `default` declared the server
//!     reports no body click at all, and the feature is silent rather than red.
//!
//! The first two are the map's policy and the third is a literal, so all three
//! are testable as pure data. What this file CANNOT prove headlessly is the
//! round trip through a real server — that the id the server answers with is the
//! id it later names in `ActionInvoked` — which is the `#[ignore]`d manual check
//! in `attention_alert_survives.rs`, not a claim made here.
//!
//! The file also holds the **raise** group: the `unminimize → show → set_focus`
//! order the click route depends on, pinned through the pure `raise_trace` seam
//! for the same reason — no window, no desktop, no compositor — and for the same
//! limited claim: ORDER and WORDING, never the behaviour on a real platform.
//!
//! # Why the map is a process global and these tests still hold
//!
//! The map has to be one per process (the signal thread and the send are
//! separate threads of one app), so it is a `static`. These tests therefore
//! share it, and each one uses server ids no other test touches (2xx / 3xx /
//! 4xx / 9xxxxx) and asserts only about ITS OWN ids — never about the map's
//! size, which another test's entry would legitimately change.

// The gate is the SAME expression as the `zbus`/`notify-rust` dependency gate in
// `Cargo.toml` and as `attention::delivery`'s: the bus transport does not exist
// on any other target, so there is nothing here to compile against.
#![cfg(all(
    unix,
    not(any(target_os = "macos", target_os = "android", target_os = "ios"))
))]

use archimedes_lib::attention::delivery::bus::{
    alert_payload, on_signal, pending_tokens, token_of, track_alert, untrack_alert, Signal,
    SignalOutcome,
};
use archimedes_lib::attention::delivery::{delivery_trace, Outcome};
use archimedes_lib::attention::AlertText;
use archimedes_lib::commands::window_state::raise_trace;

/// Every line the raise writes sits under this prefix (the same greppable-prefix
/// convention `attention: focus probe: ` uses). Pinned here rather than repeated
/// per assertion so the three raise tests cannot drift apart on a typo.
const RAISE_PREFIX: &str = "attention: raise: ";

/// An alert with an unmistakable token, so a swap or a truncation is visible.
fn alert(title: &str, body: &str, token: &str) -> AlertText {
    AlertText {
        title: title.into(),
        body: body.into(),
        click_token: token.into(),
    }
}

// ---- the actions list (the wire contract nothing else cross-checks) --------

/// The alert declares EXACTLY `["default", ""]`.
///
/// This pair is the whole reason a body click is observable: the Desktop
/// Notifications spec sends actions as id/label PAIRS, and a server reports a
/// click on the notification itself as `ActionInvoked(id, "default")` only if
/// `default` was declared. The empty label is what keeps it from rendering a
/// button the user would have to reason about. The spec's own wording is the
/// authority here, and the plugin sends the same id for the same reason.
///
/// Pinned as a literal because NO test on either side of the wire compares the
/// two spellings: the frontend listens for `attention-alert-clicked` and Rust
/// emits it, and a one-sided rename of this pair would leave the feature
/// silently dead.
#[test]
fn the_alert_declares_exactly_the_default_action_and_nothing_else() {
    let text = alert(
        "Archimedes",
        "api-server finished — waiting for you",
        "ses-1",
    );
    let notification = alert_payload(&text);

    assert_eq!(
        notification.actions,
        vec!["default".to_string(), String::new()],
        "the actions list is the two-element pair `default` + the empty label, \
         in that order, and nothing else"
    );
    assert_eq!(
        notification.actions.len(),
        2,
        "one pair, so the list cannot be read as two actions"
    );
}

/// The token is NOT alert text: it never reaches the summary, the body, or the
/// actions list — the fields that get capped, trimmed and rendered.
#[test]
fn the_token_is_not_part_of_the_alert_the_server_renders() {
    let token = "ses-TOKEN-MUST-NOT-BE-RENDERED";
    let text = alert("Archimedes", "api-server finished — waiting for you", token);
    let notification = alert_payload(&text);

    assert_eq!(notification.summary, "Archimedes");
    assert_eq!(notification.body, "api-server finished — waiting for you");
    assert!(
        !notification.actions.iter().any(|a| a.contains(token)),
        "the token is not smuggled into the actions list: {:?}",
        notification.actions
    );
}

// ---- the map: what each signal does to it ---------------------------------

/// `NotificationClosed` frees the entry — the claim that replaces the deleted
/// retention cap: the map is bounded by OUTSTANDING alerts, not by the process
/// lifetime, because the server tells us when an alert is gone.
#[test]
fn a_closed_alert_frees_its_entry() {
    let id = 201u32;
    track_alert(id, "ses-201".into());
    assert_eq!(token_of(id).as_deref(), Some("ses-201"));

    let outcome = on_signal(Signal::NotificationClosed { server_id: id });
    assert!(
        matches!(
            outcome,
            SignalOutcome::Closed {
                server_id: 201,
                was_tracked: true
            }
        ),
        "the close of a tracked alert says so and frees the entry, got {outcome:?}"
    );
    assert_eq!(
        token_of(id),
        None,
        "a closed alert leaves nothing behind: this is what bounds the map"
    );
}

/// A close for an id we never sent is still a close — it just frees nothing. The
/// thread must not treat it as an error or as a click.
#[test]
fn a_close_for_an_alert_we_never_sent_frees_nothing_and_reports_nothing() {
    let id = 987_654u32;
    assert_eq!(token_of(id), None, "the id is untracked to begin with");

    let outcome = on_signal(Signal::NotificationClosed { server_id: id });
    assert!(
        matches!(
            outcome,
            SignalOutcome::Closed {
                server_id: 987_654,
                was_tracked: false
            }
        ),
        "an untracked close is reported as such, got {outcome:?}"
    );
}

/// A body click echoes the stored token VERBATIM and frees the entry, so the
/// same alert cannot navigate twice.
#[test]
fn a_body_click_echoes_the_token_and_frees_the_entry() {
    let id = 301u32;
    track_alert(id, "ses-301".into());

    let outcome = on_signal(Signal::ActionInvoked {
        server_id: id,
        action: "default".into(),
    });
    match outcome {
        SignalOutcome::Clicked { server_id, token } => {
            assert_eq!(server_id, id);
            assert_eq!(
                token, "ses-301",
                "the click carries the stored token, byte for byte"
            );
        }
        other => panic!("a body click on a tracked alert must report a click, got {other:?}"),
    }

    assert_eq!(
        token_of(id),
        None,
        "a clicked alert is forgotten, so a second click on the same banner \
         cannot fire a second navigation"
    );
}

/// An action that is not the body click is not a click — a button of the
/// server's own (or another app's action) must never navigate anywhere. The
/// entry STAYS, because the alert is still on screen and its body click is still
/// owed; only the click itself or the close frees it.
#[test]
fn an_action_that_is_not_the_body_click_reports_no_click() {
    let id = 401u32;
    track_alert(id, "ses-401".into());

    for action in ["", "ok", "default ", "Default", "dismiss"] {
        let outcome = on_signal(Signal::ActionInvoked {
            server_id: id,
            action: action.into(),
        });
        assert!(
            matches!(outcome, SignalOutcome::OtherAction { .. }),
            "`{action:?}` is not the body click and must report no click, got {outcome:?}"
        );
    }
    assert_eq!(
        token_of(id).as_deref(),
        Some("ses-401"),
        "a non-click leaves the alert tracked — its body click is still owed"
    );
}

/// A signal about an alert this process never sent is not a click. That is the
/// case that matters on a shared session bus: another app's alert, or one of ours
/// from before a restart, arrives on the same broadcast.
#[test]
fn a_click_on_an_alert_we_never_sent_reports_no_click() {
    let id = 987_650u32;
    let outcome = on_signal(Signal::ActionInvoked {
        server_id: id,
        action: "default".into(),
    });
    assert!(
        matches!(outcome, SignalOutcome::Untracked { server_id: 987_650 }),
        "an untracked id is refused a click (a stale alert must not navigate), \
         got {outcome:?}"
    );
}

// ---- the token is opaque --------------------------------------------------

/// Rust never parses, trims, caps or validates the token: it is stored and
/// echoed exactly as it arrived, INCLUDING the shapes the alert text refuses.
///
/// This is the boundary the plan fixes: the token rides beside the capped title
/// and body, never through them. An empty token, a whitespace token, a token
/// past every length budget and a token with non-UTF8-looking punctuation are
/// all stored verbatim, and none of them can trigger the empty-body refusal —
/// that refusal lives in `alert_text`, which never sees a token.
#[test]
fn the_token_is_stored_and_echoed_verbatim_in_every_shape_the_text_refuses() {
    let shapes = [
        String::new(),
        "   ".into(),
        "\n\t ".into(),
        "ses/with spaces and 中文".into(),
        "x".repeat(10_000),
    ];

    for (index, token) in shapes.iter().enumerate() {
        // 5xx per shape so one test's ids cannot collide with another's.
        let id = 500 + index as u32;
        track_alert(id, token.clone());
        assert_eq!(
            token_of(id).as_deref(),
            Some(token.as_str()),
            "a token of {len} chars survives the map unchanged",
            len = token.chars().count()
        );

        let outcome = on_signal(Signal::ActionInvoked {
            server_id: id,
            action: "default".into(),
        });
        match outcome {
            SignalOutcome::Clicked { token: echoed, .. } => assert_eq!(
                &echoed, token,
                "the click echoes the token byte for byte, even this one"
            ),
            other => panic!("every stored token is clickable, got {other:?}"),
        }
    }
}

/// An empty token is CLICKABLE. Stated apart from the loop above because it is
/// the specific confusion the plan warns about: an empty BODY is refused (the
/// renderer composed nothing), and a reader who conflates the two would refuse
/// the click too — silently killing the feature for any alert whose renderer
/// sent no token.
#[test]
fn an_empty_token_is_still_tracked_and_still_clickable() {
    let id = 601u32;
    track_alert(id, String::new());
    let tracked = pending_tokens();
    assert!(
        tracked
            .iter()
            .any(|(seen, token)| { *seen == id && token.is_empty() }),
        "an empty token is an entry like any other (the empty-BODY refusal never \
         sees a token): {tracked:?}"
    );

    assert!(
        matches!(
            on_signal(Signal::ActionInvoked {
                server_id: id,
                action: "default".into(),
            }),
            SignalOutcome::Clicked { .. }
        ),
        "an empty token still reports a click"
    );
}

/// Dropping an entry by hand frees exactly that entry (the seam the signal
/// thread drives, asserted on its own so a `Closed` result cannot hide a
/// map-layer bug).
#[test]
fn untracking_frees_one_entry_and_leaves_the_others() {
    let (a, b) = (701u32, 702u32);
    track_alert(a, "ses-701".into());
    track_alert(b, "ses-702".into());

    assert_eq!(untrack_alert(a), Some("ses-701".into()));
    assert_eq!(token_of(a), None, "the id we freed is gone");
    assert_eq!(
        token_of(b).as_deref(),
        Some("ses-702"),
        "freeing one entry frees nothing else"
    );
    assert_eq!(
        untrack_alert(a),
        None,
        "freeing it twice is a no-op, not a second release"
    );
    untrack_alert(b);
}

/// Re-arming under an id the server reuses overwrites the token instead of
/// stacking two claims on one id (the spec allows a server to hand out ids
/// again after a close).
#[test]
fn a_reused_id_carries_the_newest_token_only() {
    let id = 801u32;
    track_alert(id, "ses-old".into());
    track_alert(id, "ses-new".into());
    assert_eq!(token_of(id).as_deref(), Some("ses-new"));
    assert_eq!(
        pending_tokens()
            .iter()
            .filter(|(seen, _)| *seen == id)
            .count(),
        1,
        "one id is one entry"
    );
    untrack_alert(id);
}

// ---- the raise: the ORDER, and one line per step --------------------------

/// The raise that follows a click runs `unminimize()` → `show()` → `set_focus()`
/// IN THAT ORDER, and every step gets its own log line.
///
/// The order is the load-bearing claim, and it is a platform fact rather than a
/// taste: tao's Linux `set_focus()` is guarded by `!minimized && visible` and
/// otherwise **silently no-ops** — a focus-first raise on a minimized window
/// would report success and do nothing, which is the worst failure this feature
/// can have (silent). So the assertion is on the SEQUENCE of lines.
///
/// What this proves is ORDER and WORDING, and nothing more. No window is
/// constructed here (a second `generate_context!()` in one test binary duplicates
/// `embed_plist`'s `_EMBED_INFO_PLIST` and reddens macOS `cargo test` while
/// clippy stays green), and nothing on this machine runs a raise: the
/// `x86_64-pc-windows-gnu` check type-checks, and there is no wine and no macOS
/// host. The behaviour on Windows and under Wayland stays unverified.
#[test]
fn the_raise_runs_unminimize_then_show_then_set_focus() {
    let (attempted, lines) = raise_trace(Some(Ok(())), Some(Ok(())), Some(Ok(())));

    assert!(attempted, "a resolved window means a raise was attempted");
    assert_eq!(
        lines.len(),
        3,
        "three steps, one line each — a missing line means a step was skipped"
    );
    assert!(
        lines[0].starts_with("attention: raise: unminimize"),
        "step 1 is unminimize (a minimized window cannot be focused): {:?}",
        lines[0]
    );
    assert!(
        lines[1].starts_with("attention: raise: show"),
        "step 2 is show (an invisible window cannot be focused): {:?}",
        lines[1]
    );
    assert!(
        lines[2].starts_with("attention: raise: focused"),
        "step 3 is set_focus, LAST, because it is the step that silently no-ops \
         unless the first two ran: {:?}",
        lines[2]
    );
    for line in &lines {
        assert!(
            line.starts_with(RAISE_PREFIX),
            "every raise line is greppable under {RAISE_PREFIX:?}: {line}"
        );
    }
}

/// A refused step gets its OWN line AND the later steps still get theirs.
///
/// Two claims in one, both from the spec: "each step's refusal gets its own
/// debuglog line", and the one that decides whether the raise ever works — a
/// refusal of step N must NOT skip step N+1. `unminimize()` on a window that is
/// already un-minimized is a no-op or an error depending on the platform, and
/// `show()` + `set_focus()` can still bring it forward; an early return on the
/// first refusal would leave the window buried on exactly the desktops this
/// feature was asked for.
#[test]
fn a_refused_step_gets_its_own_line_and_does_not_skip_the_rest() {
    let (attempted, lines) = raise_trace(
        Some(Err("window is not minimized".into())),
        Some(Ok(())),
        Some(Ok(())),
    );

    assert!(attempted, "a refusal is not an absence of window");
    assert_eq!(
        lines.len(),
        3,
        "still three lines — a refusal cannot shorten the sequence (that is the \
         no-early-return claim): {lines:?}"
    );
    assert!(
        lines[0].starts_with("attention: raise: unminimize refused: "),
        "the refusal names the step that refused and quotes its Display: {:?}",
        lines[0]
    );
    assert!(
        lines[0].contains("window is not minimized"),
        "the platform's own message survives verbatim: {:?}",
        lines[0]
    );
    assert!(
        lines[1].starts_with("attention: raise: shown"),
        "show() still ran and is still narrated: {:?}",
        lines[1]
    );
    assert!(
        lines[2].starts_with("attention: raise: focused"),
        "set_focus() still ran and is still narrated: {:?}",
        lines[2]
    );
}

/// No window labelled `main` is narrated ONCE, as the absence of a window — not
/// as three refusals of calls that were never made.
///
/// This is the case the raise is best-effort about: the command still answers
/// `Ok(())` (the wire contract), so the log line is the ONLY evidence the click
/// reached Rust and nothing moved. Hence it names the label it looked for, the
/// same convention the focus probe uses for the same reason.
#[test]
fn a_raise_with_no_window_is_one_line_naming_the_label() {
    let (attempted, lines) = raise_trace(None, None, None);

    assert!(!attempted, "with no window there was nothing to attempt");
    assert_eq!(
        lines.len(),
        1,
        "one line for one absence — three identical refusals of calls that were \
         never made would read as three platform failures: {lines:?}"
    );
    assert!(
        lines[0].starts_with(RAISE_PREFIX),
        "the absence is under the same prefix as the steps: {:?}",
        lines[0]
    );
    assert!(
        lines[0].contains("no window labelled \"main\""),
        "the line names the LABEL it resolved, so a label mismatch is not \
         mistaken for a window that refused: {:?}",
        lines[0]
    );
}

// ---- the log line (the token must never reach it) -------------------------

/// The standing rule, restated where the token is in scope: nothing a delivery
/// writes to the debug log carries the token — which is a Session id, i.e. the
/// same kind of identifier the alert's text is kept out of the log for.
///
/// `Outcome` structurally cannot hold a token (the `Accepted` variant carries the
/// server's id and nothing else), and that IS the design; this pin is what stops
/// someone "helpfully" adding one to the line.
#[test]
fn no_trace_line_carries_the_token() {
    let token = "ses-TOKEN-MUST-NOT-REACH-THE-LOG";
    for outcome in [
        Outcome::Accepted { id: 42 },
        Outcome::HandedOff,
        Outcome::Refused("boom".into()),
    ] {
        let line = delivery_trace(&outcome);
        assert!(!line.contains(token) && !line.contains("ses-"), "{line}");
    }
}
