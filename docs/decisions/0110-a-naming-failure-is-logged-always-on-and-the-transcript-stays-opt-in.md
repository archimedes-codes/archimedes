---
status: accepted
date: 2026-11-16
superseded-by:
---

# A naming failure is logged always-on, and the protocol transcript stays opt-in

A session that could not be titled said so nowhere. Every diagnostic in the naming pass went through
`debuglog::log`, which returns at its **first statement** unless `ARCHIMEDES_DEBUG=1`. A user who
launches from a desktop entry sets no env var, and in a bundled app `eprintln!` has no reader at all,
so a refusal produced no file, no message, and no clue — and a supporter asking "why is there no
title?" had nothing to ask for. Issue #143's whole diagnosis needed the user to reproduce with a
variable they had never heard of.

The fix is to log those lines to a channel that is always on. The thing that nearly happened instead —
flipping `debuglog` on by default — would have been a privacy bug, and that is the part worth keeping.

## The switch must not be flipped, because the gated log is a transcript

`supervisor.log` is not an error log. `fulcrum-harness`'s `worker/client.rs` writes **every protocol
frame in both directions** through `log_truncated("→", …)` and `("←", …)`, and `Inbound::Prompt { text }`
is one of those frames. The file therefore carries the user's **conversation** and the model's **token
stream**, cut only to 2 KB per line. That is exactly what makes it correct to leave behind an opt-in
switch, and exactly why making a handful of refusal lines visible could not be done by turning it.

So the desktop now arms a second engine channel, `fulcrum_harness::diagnostics`, which writes to
`diagnostics.log`:

| | `debuglog` | `diagnostics` |
|---|---|---|
| gate | `ARCHIMEDES_DEBUG=1` | **none** |
| file | `supervisor.log` | `diagnostics.log` |
| content | full transcript, prompts included | curated; no prompts, transcript, tokens, or bearer |
| rotation | 5 MB | 1 MB |

Both live in the same directory as the crash logs, so a supporter asked for "the logs" gets one folder.

## What moved, and what deliberately did not

All nine `session-name:` lines in `agent/session/naming.rs` moved to the always-on channel. Each was
read before moving it, because the engine states the rule for this file: **no user content**. What the
nine carry is a model id, a session id, a configured reasoning level, a `FinishReason`, a database error,
and a provider error's `Display` — no prompt, no excerpt, no answer text. `title_prompt`'s excerpt, which
is the user's own words, is never logged on either channel.

The provider error is the one worth naming: `transport.rs`'s `map_status` embeds the **response body**
into the error (`status {status}: {body}`, untruncated), so that body now reaches `diagnostics.log`. A
provider echoes the request back in a 4xx, which is how "model not found" and a context-overflow
message read. `debuglog::log` already accepted that, so the migration adds no new exposure — but it does
mean the always-on file inherits an upstream habit this repo does not control. If a provider is ever
found echoing a full prompt there, the fix is to truncate at the call site, not to re-gate the line.

The `commands/sessions.rs` `ipc … FAILED` lines stayed behind `debuglog`. They are IPC chatter on a busy
path, not a refusal that explains a silence, and widening this channel is a per-line decision — which is
why it is a separate module rather than a log level on the old one.

## Arming, and why the module cannot arm itself

`diagnostics::init(Some(dir))` is called in `run()`, beside `debuglog::init_from_env()` and the crash
hook, reusing the `dirs::data_dir()` resolution already there — the change adds no second data-dir
resolution. The engine's channel is **unarmed until a host injects the directory**, and that is the
engine's decision, not this one's: a lazy default would make `cargo test` write into the developer's real
data dir, because a manager test reaches the pump's frame-drop line and inits nothing.

## The tests had to change, and that is the point

Two tests asserted the naming lines land in `supervisor.log`. They were true, and they described a build
the user opted into — in the build a user actually runs, the pass was silent. Both now assert
`diagnostics.log`, and a third asserts the transcript file is **not created** by a naming pass that never
opted in, which is what distinguishes a moved line from a duplicated one.

Two things this caught, both worth remembering:

- **A nested `#[tokio::test]` compiles and registers nothing.** Inserting the new test at the wrong
  nesting level left the count at 77 and the test invisible; `--list` was the only thing that showed it.
  A count that does not move is the signal.
- **`cargo clippy` replays cached warnings.** It reported "0 warnings" in 0.34 s without printing a
  `Checking` line. Touching the sources produced the real 3.4 s re-check. A green clippy that never
  re-checked is the vacuous-pass class, so require the `Checking` line.

## What this does not fix

The **Worker** still never calls `init_from_env` or arms diagnostics, so a line logged inside a Worker
process remains a silent no-op. That is documented engine-side and unchanged here; the naming pass runs
in the Supervisor, so it is unaffected. The app-quit gap from ADR 0109 also stands: `RunEvent::Exit`
reaps Workers and never reaches `close_session`, so quitting still produces no last-chance title.
