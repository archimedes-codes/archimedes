---
status: accepted
date: 2026-10-19
superseded-by:
---

# IPC errors carry a `kind` and a `message`, Rust owns the sentence, and the payload is hand-built because a serde failure is a compile error and never a runtime one

A Windows user's first Space failed to open and the app said **`[object Object]`**. There was nothing to read and nothing on disk: every session command renders that way, and the release build has no console, so the one sentence that existed was never written down anywhere. We decided: the IPC error envelope is a named contract — `{ "kind": <snake_case discriminator>, "message": <the Display sentence>, …the variant's own field }` — with **Rust owning the sentence**, and `SessionError` gets its wire form from a hand-written `impl From<SessionError> for tauri::ipc::InvokeError` (`src-tauri/src/agent/errors.rs`) with the serde `Serialize` derive **removed**, so a payload serde cannot encode stops being a user-facing string and becomes a compile error in that one file.

**Numbering, so nobody renumbers after a merge race:** this is **0063**, and the number is not "highest in the directory + 1". `0062` exists on the unmerged `feature/ui-design-lightning-round` — absent from this checkout and from `main`, but taken in git. `0058`/`0059` are **not free either**: the unmerged `feature/web-search-and-fetch` carries both (and its `0056`/`0057` are different ADRs from `main`'s same-numbered files, while `main`'s `router.rs`, `web/render.rs` and `navigation_guard.rs` already cite "ADR 0058" in comments with no file behind the citation on this checkout). That trap is written up in `docs/research/windows-child-console-window.md`, in the closing **"One trap for whoever lands `feature/web-search-and-fetch`"** paragraph — the one that records *"Highest number in the directory + 1" is not computable here* and names the gaps as historical (cited by that phrase rather than by line number, because a `file:line` into a living research doc rots within a branch — this very citation pointed at the wrong line from the day it was written, and this branch's edits moved the target again). That is why the 0060 decision took 0060; the genuine historical gaps are `0009` and `0012`, and nothing is coming to fill them. 0063 is the first number that cannot collide with anything in this repository's object database.

## The failure had two halves, and the second was worse

A Tauri command that rejects delivers either a **string** (the `Result<_, String>` commands, the large majority of the surface) or, when the Rust side returns a typed error, a **plain JSON object**. Every frontend site that rendered a rejection funneled the non-`Error` case through `String(…)` — 15 with the one-line idiom `e instanceof Error ? e.message : String(e)` (inherited from when a rejection was always a string), one with the same three-way unwrap spread over six lines where a grep for that idiom cannot see it, and two as a bare `String(error)` — and `String({…})` is exactly `[object Object]`. Nine commands in `src-tauri/src/commands/sessions.rs` return `Result<_, SessionError>` (`get_stalled_info`, the tenth, returns `Result<_, String>`), so nine commands were unreadable, including the one the report was about.

Then the payload itself was wrong, in a way no frontend change could fix. `SessionError` derived serde `Serialize` with `#[serde(tag = "kind", rename_all = "snake_case")]`, and an internally-tagged enum **cannot serialize a newtype variant containing a string**. `SessionError::Io(String)` is exactly that shape, and it is the constructor used 13 times in `agent/session/mod.rs`. Serde refused, and Tauri's blanket conversion swallowed the refusal:

```rust
impl<T: Serialize> From<T> for InvokeError {
  fn from(value: T) -> Self {
    serde_json::to_value(value).map(Self).unwrap_or_else(Self::from_error)
  }
} // tauri-2.12.2/src/ipc/mod.rs:240-247
```

So for those 13 sites the user did not see `[object Object]` — they saw `"cannot serialize tagged newtype variant SessionError::Io containing a string"`, the encoder's complaint standing in for the reason. Six of the seven variants had no `message` key at all, so even a renderer that knew to look had nothing to look for.

## Decision: the envelope, and who writes the prose

```json
{ "kind": "folder_missing", "message": "folder not found: C:\\work", "path": "C:\\work" }
```

- `kind` is the snake_case discriminator, byte-identical to what the deleted `#[serde(rename_all = "snake_case")]` produced — anything already reading it keeps working. Seven values: `io`, `command`, `unknown_session`, `not_resumable`, `folder_missing`, `invalid_prompt`, `settle_timeout`.
- `message` is the variant's `#[error(…)]` `Display` sentence. **Always present, always non-empty** — it is the only key the frontend renders, which is why the payload is built by hand rather than derived.
- The variant's own field keeps the name the derived shape gave it (`error`, `id`, `path`, `reason`, `detail`), so a structured consumer is unaffected. `Io` adds none: its payload already IS the whole `message` (`"i/o error: …"`).

**Rust owns the sentence.** The frontend never assembles prose from `kind`, never maps a `kind` to copy, never localizes it. `kind` is for machines and for the last-resort step below. The consequence is that adding an error variant means writing its user-facing English in `errors.rs`, in the `#[error(…)]` attribute, next to the variant — one place, one language, one owner.

**And the derive stays off, which is the load-bearing half.** With no `Serialize`, Tauri's blanket `impl<T: Serialize>` cannot apply, so the only route from `SessionError` to the wire is the one we wrote. A future variant holding something unserializable is then a **compile error in `errors.rs`**, not a silent trip through `unwrap_or_else(Self::from_error)` that prints the encoder's complaint on the user's screen. Both the `kind()` match and the `From` match are exhaustive with no catch-all arm, so a new variant must be named twice in this file — which is the whole point: the bug class this replaces was a payload that no one had to think about. `tauri::ipc::InvokeError`'s single field is `pub` (`tauri-2.12.2/src/ipc/mod.rs:224`), so the envelope is constructible from app code; nothing outside this file builds one.

## Decision: the frontend's resolution order is normative

`describeIpcError(err: unknown): string` (`src/lib/ipcError.ts`, zero imports) resolves in this order and no other:

1. `typeof err === "string"` → the string itself — the `Err(String)` commands, where the wire error *is* the message.
2. `err instanceof Error` → `err.message` — a JS-side throw, not the IPC path.
3. a non-null object with a **string** `message` → that string — the envelope above, and the rule that fixed the report.
4. a non-null object with a string `kind` → the `kind` alone — worse than a sentence, better than nothing, and what an older backend behind a newer webview yields.
5. otherwise → `String(err)`, and if that is exactly `"[object Object]"`, `"unknown error"` instead.

Step 5 is wrapped in `try`/`catch` also returning `"unknown error"`, because `String()` itself throws (`TypeError: Cannot convert a … to primitive value`) on `Object.create(null)` and `{ toString: null }`. That is unreachable from a real Tauri rejection — the wire is JSON — but the function is documented as total: never throws, always returns a string, and **`[object Object]` is a forbidden output**. It is a selector, not a formatter: it localizes nothing, prefixes nothing, adds no punctuation.

## Considered Options

- **Make every command return `Err(String)` (rejected).** One type, no envelope, and the whole frontend bug evaporates — because there would be no object to stringify. Rejected: it deletes `kind`, and the typed codes are the diagnostic on the surfaces that use them. `commands/open.rs` returns `crate::open`'s refusal codes (`denied-scheme:javascript`, `relative-without-cwd`, `os-error:…`) and the updater maps its plugin error to `release-not-found`, `endpoints-not-configured`, `signature-mismatch` (`map_check_error` in `commands/update.rs`) — a code a supporter greps for and a test asserts (`UpdateSection.test.tsx` pins `release-not-found` reaching the UI). Collapsing the session errors into strings to fix a renderer is paying for a display bug with a contract.
- **Always-on logging of rejected commands (rejected — the option a reviewer preferred).** The review wanted a log that exists. It is recorded here because it is the honest alternative, not a strawman: this bug was unauditable precisely because the switch was opt-in *and undocumented*. The counter-argument that carried it: the diagnostic surface stays **one** switch (`ARCHIMEDES_DEBUG`) that already governs the Worker protocol log and the worker lifecycle lines, it inherits that log's existing 5 MB rotation, and a normal run writes nothing to disk at all — `debuglog::log` is a cached atomic read when disabled and creates no file (`agent/debuglog.rs:60-68`), so wrapping all nine session commands in `logged(…)` costs nothing with the variable unset (`commands/sessions.rs:45-69`). **The accepted cost, named:** a person reporting a bug must set `ARCHIMEDES_DEBUG=1` **before** reproducing it — exactly the step that hid this report, and the reason the decision is only tolerable together with `README.md`'s `## Diagnostics` section. If the switch proves too costly in practice, reopen this bullet rather than re-deriving it.
- **Patch `@tauri-apps/api`'s `core.js` to unwrap the object (rejected).** It would fix every app on the wire rather than every call site in ours. It is also a vendored-asset fork for a one-line problem: the upstream behaviour is not wrong (it delivers a faithful JSON payload), and a patched node_modules is a build step that nobody on this repo can reproduce from a lockfile.
- **Fix only the two sites in the reported flow (rejected).** The failure was identical at all 18 rendering sites, so a partial fix leaves 16 latent copies of a bug whose symptom is "the user cannot read the error" — and the two sites in the flow were the two a future report is least likely to name. (19 call sites adopt the helper: the 18 renderers plus the one console site the exclusion rule below pulls in.)
- **Keep the derive and special-case `Io` (rejected).** It fixes the one variant that happens to be shaped badly and leaves the trap loaded: the next unserializable payload reappears on screen as the encoder's sentence. Removing the derive is what makes the class unrepresentable rather than improbable, and serde gives no hook to intercept the failure — the `unwrap_or_else` is inside Tauri's impl, not ours.

## What keeps the contract honest

- `src/lib/ipcError.test.ts` — 21 cases over the resolution order, including `Object.create(null)`, `{ toString: null }`, an inherited `message` getter, and an assertion that **no** input returns `"[object Object]"`.
- `agent/errors.rs`'s `every_variant_reaches_the_wire_with_a_kind_and_a_nonempty_message` — iterates all seven variants, asserts an object with a `kind`, a non-empty `message` equal to `Display`, and the variant's field; plus `io_reaches_the_wire_as_its_own_sentence_not_a_serde_complaint`, which asserts the string `cannot serialize` never reaches the wire.
- **Two invariant greps**, which do not cover the same ground. `grep -rn "instanceof Error ? " src/ --include=*.ts --include=*.tsx | grep -v "\.test\." | grep -v "lib/ipcError.ts"` must be empty; and `grep -rnE "String\((err|error|e|ex)\)" src/ …` must be empty. The second is not redundant: `settings/UpdateSection.tsx`'s two sites were bare `String(error)` and the first grep structurally cannot see them — yet they were the worst, because the updater's typed codes went through that fallback. Both are empty as of this ADR; both are manual, so they belong in review, not only in a PR checklist.
- `tests/storage.rs::the_session_cwd_string_and_the_space_path_key_are_the_same_string` — the characterization test from this branch. It says nothing about errors; it is the tripwire for the one change that could revisit the envelope indirectly, by re-spelling `SessionInfo.cwd`, since `message` interpolates that path into user-visible prose — and that change is governed by **ADR 0064**, which records why the Windows verbatim prefix in that field cannot be normalized on one side. Nothing else in this envelope depends on the path's spelling.

## Exclusion rule, and what it deliberately leaves dark

Console-only sites are **out of scope**: logging a rejection is not rendering one. The one exception is a module that already owns that message's formatting — which is why `src/lib/tauri.ts`'s external-open wrapper does call the helper (it composes the whole `external open refused: …` line; `Err(String)` today, so the output is unchanged and the line is merely future-proofed). Everything else that catches and console-logs stays as written: `SpaceTabs.tsx`, `SpacesList.tsx`, `SettingsPage.tsx`, the catalog hooks, the store's quiet catches.

**What that leaves open, and accepted:** a `close_session` rejection is logged server-side (`ipc close_session FAILED: …`) and `console.error`-ed in the renderer and **rendered nowhere** — a Space whose sessions failed to stop looks exactly like one that closed cleanly. Fixing it is a product call about whether a banner is warranted, not an envelope question; the envelope now guarantees the sentence exists when someone decides to show it.

## Consequences

- **A new error variant is a three-line obligation in one file**: the variant, its `#[error(…)]` sentence, and its arms in `kind()` and the `From` match. The compiler enforces the second half; the first half is review. The frontend needs no change, by design.
- **`message` is user-visible text, so it is now translatable-adjacent surface with no i18n behind it.** It is Rust `Display` prose in English, and the app has no localization layer. If one ever lands, the sentence's owner has to be renegotiated — this ADR is where that argument starts, and "the frontend assembles prose from `kind`" is the shape it must not take.
- **Rejections of the nine session commands land in `supervisor.log` as `ipc <name> FAILED: <Display>`** — the same words, character for character, that the user saw, which is what makes a screenshot and a support log one piece of evidence. Arguments are deliberately not logged: `send_prompt` carries the user's prompt text.
- **`%APPDATA%\archimedes` is the Windows instruction, and it is not variable.** `dirs` 6.0.0 resolves the Windows data dir through `SHGetKnownFolderPath(FOLDERID_RoamingAppData)` (`dirs-6.0.0/src/win.rs:10`, `dirs-sys-0.5.0/src/lib.rs:150-178`), which **ignores `%APPDATA%`** — recorded in ADR 0025 as the reason `scripts/check-test-data-dir.sh` has no Windows arm, because a Windows "redirect" would move nothing and the check would pass for the wrong reason. Pointing a supporter at the Roaming path itself is therefore the only reliable instruction there. Worth knowing beside it: on Windows (and on macOS) `dirs::config_dir()` resolves to the SAME base as `dirs::data_dir()`, so `settings.json` sits in the very `archimedes` directory the logs live in; only on Linux are they separate (`~/.config/archimedes` vs `~/.local/share/archimedes`). Note in passing that `lib.rs`'s setup comment lists `%LOCALAPPDATA%/archimedes` among the app's on-disk dirs — `dirs::data_local_dir()` is never called in this crate, so nothing is written there today.
- **The console-free release build is why any of this needed a file at all**: `src-tauri/src/main.rs:2` sets `windows_subsystem = "windows"` for release, so `eprintln!` has nowhere to go on a shipped Windows build and the crash log is the only trace a panic left. Recorded in `README.md`'s `## Diagnostics`, next to the paths.
- **`kind` has exactly one reader today and it is a fallback** (`describeIpcError`'s rule 4). Nothing in `src/` branches on one of the seven error `kind` values — a grep for `unknown_session` / `folder_missing` / `settle_timeout` hits only `ipcError.test.ts`. That is not a licence to churn them: `kind` is a stable identifier a supporter quotes in a report, and it is the value a future consumer would switch on. But nobody should assume a hidden switch is already there, and nobody should add one to this file — the place a `kind` earns behaviour is Rust, beside the variant.

## Amendment (2026-10-30) — the error type is chosen by the wire, not by the file

Added when Finding 20 of `docs/reviews/2026-10-30-codebase-improvement.md` was implemented
(`docs/roadmap/improvement-correctness-seams-task14-error-envelope-rust.md`). The decision above is
unchanged and not renumbered; this section settles a competing rule that had grown up beside it and
records the vocabulary the migration added.

### The sentence

**The error type is chosen by the wire, not by the file.**

`d509958` ("expose `session_recency`, `reorder_sessions` and `reorder_spaces` as commands") chose
**both** dialects in one commit and then wrote down the rule that produced it: *"Error types follow the
file they live in: `String` via `map_err(to_string)` in `history.rs`, `SpacesError::Database` in
``spaces.rs."* That is a per-**file** rule standing against this ADR's per-**wire** rule, and it is what
this amendment rejects. It cost two commands that wrap the same `DbError` from the same layer for the
same user gesture (`reorder_sessions` in `history.rs`, `reorder_spaces` in `spaces.rs`) two different
dialects for no reason a reader could recover. It also decides a split the migration had to make:
`commands/history.rs::list_sessions` returns `SessionError` (it delegates to `SessionManager`, so its
wire is the session wire) while the five `DbError`-backed commands beside it return `HistoryError`. The
discriminator is the wire surface a command answers on, never the module it is declared in.

### The kind vocabulary this migration added

All hand-built in `src-tauri/src/agent/errors.rs`, all with **no `Serialize` derive** — the load-bearing
half of this ADR, unchanged: no derive means Tauri's blanket `impl<T: Serialize> From<T> for InvokeError`
cannot win, so a payload the envelope cannot express is a compile error in that file. Each enum's
`kind()` match and its `From` match are exhaustive with no catch-all arm, so a new variant must be named
twice. The spellings below are frozen by drift pins in that file's test module (the shape of
`compaction_reason_serde_spellings_are_frozen`), and the frontend mirror copies those frozen lists
rather than guessing:

| error type | kinds (frozen) | frozen by |
|---|---|---|
| `HistoryError` | `sqlite` · `io` · `json` | `history_error_kind_spellings_are_frozen` |
| `AttentionError` | `attention_empty_body` · `attention_no_runtime` | `attention_error_kind_spellings_are_frozen` |
| `ClipboardError` | `clipboard` · `encode` | `clipboard_error_kind_spellings_are_frozen` |
| `OpenError` | `invalid_href` · `denied_scheme` · `relative_without_cwd` · `os_error` · `other` | `open_error_kind_of_maps_the_refusal_codes` |
| `UpdateError` | `release_not_found` · `endpoints_not_configured` · `network` · `invalid_target` · `signature_mismatch` · `install_failed` · `install_in_progress` · `no_update_available` · `unsupported_platform` · `invalid_update_format` · `authentication_failed` · `io` · `other` | `update_error_kind_of_maps_the_frozen_code_table` |

`AttentionError`'s two kinds were a genuine open choice (the bare `empty_body` / `no_runtime` was the
other candidate). The family-prefixed pair was taken and is frozen by the pin, for the reason this ADR
already gives for `kind` being a supporter-quotable identifier: one frontend union holds every family's
kinds, and a bare `empty_body` does not say which wire it came from.

Two files commands reuse an existing type instead of growing a new one: `list_space_files` and
`list_completion_entries` answer `FilesError` (zero new enum; the reuse is decided here, the signature
retypes in that same phantom batch). `list_skills` answers with **no error type at all** (see below).
`commands/open.rs` and `commands/update.rs` wrap code tables owned elsewhere — `crate::open`'s
`Refusal::code()` and `map_check_error` — as newtypes whose `message` **IS** the code verbatim, so the
envelope adds `kind` without editing a sentence a bug report is read from.

**`message` stayed byte-identical to the pre-migration sentence for every migrated command.** That is
the wire wall the migration was gated on, not a nicety: the frontend renders `message` and nothing else
(`describeIpcError`'s rule 3), `UpdateSection.test.tsx` pins `release-not-found` and `install-failed`
reaching the UI, and `AGENTS.md`'s release ceremony quotes `release-not-found` as what an installed
client reads when a draft 404s. `kind` is the only addition; no `Ok` payload changed.

### The phantom note: five commands typed an error that cannot exist

Five commands declared `Result<_, String>` while **no code path constructed an `Err`** — the error type
typed a branch that cannot be taken: `get_stalled_info`, `attention_disarm`, `list_skills`,
`list_space_files`, `list_completion_entries`. (The finding's "3 commands with no error type" predates
this census.) The rule they migrate to: four carry a typed error of their family that is still never
constructed (`SessionError`, `AttentionError`, `FilesError` ×2); `list_skills` is the one genuinely
infallible retirement and returns a bare `Vec<SkillInfo>` — its doc already said "Never fails", and
discovery is total (a missing root or unreadable file is skipped). Those five signatures are the
phantom/small batch (`commands/sessions.rs`, `skills.rs`, `files/mod.rs`, `attention_disarm`) and land
in that commit, not the one that amended this file; the `AttentionError` they depend on is on the tree
first, and its frozen kinds are the arbiter that batch's tests assert against. The consequence for the
grep-level guard that checks every `#[tauri::command]` returns a typed error: its allowlist needs exactly
one entry, and the reason it must cite is *"the command constructs no `Err` on any path"*.

This also re-scopes the Consequences bullet about `ipc <name> FAILED: <Display>` in `supervisor.log`:
that line exists for a **typed-envelope command that actually rejects**. A never-constructed phantom
never writes it, and an infallible command cannot write it at all — so the log line is evidence that a
rejection happened, not a per-command guarantee that one could.

### One free-text match the envelope does not yet cover

`src/components/settings/McpSection.tsx` decides whether to offer the OAuth button by testing
`result.error.includes("needs-auth")` — a match against the **free-text `message`**, not a `kind`. It
works today because `test_mcp_server` → `agent::mcp::manager::test_server` (a free function, not
`ensure_connected`) propagates the raw marker from `agent/mcp/http.rs`'s 401-on-OAuth arm, so the wire
payload is `{"kind":"mcp_test_failed","message":"needs-auth"}` and `describeIpcError` hands back that
string. The `kind` is always `mcp_test_failed`, so there is **no machine discriminator** on the auth
case, and any Rust-side reword of that sentence breaks the badge silently while the envelope stays
valid. Naming it here so nobody reads the badge as an example of switching on `kind`: it is the
opposite — the case for giving the auth arm its own kind, which is a frontend-and-settings change
tracked separately, not a reword of the sentence.

## Amendment (2026-11-20) — the error-English guarantee is per-family, not per-file, and `errors.rs` stays one file anyway

Asked by card #38, which asked whether the three recorded refusals to split
`src-tauri/src/agent/errors.rs` should be reopened, and answered from
`docs/research/agent-errors-rs-per-family-guarantee-and-the-reopen-argument.md`, measured at
`add3054a`. The decision above is unchanged and not renumbered, and so is the 2026-10-30 amendment;
this section answers the question, records the correction two living docs need for having read this
ADR as a one-file rule, and reaffirms the decline on its actual grounds. This ADR is NOT superseded
and its `status` is unchanged, and no number is minted for a reaffirmation — for the reason ADR 0079
gives: *"a `superseded-by` would erase the record of which decisions were re-affirmed, which is the
part a future reader needs."*

### The guarantee is per-variant and per-enum; the path inside it is a locator, not the rule

Both sentences in this ADR that say where a new variant's user-facing English goes are scoped to one
variant:

> "adding an error variant means writing its user-facing English in `errors.rs`, in the `#[error(…)]`
> attribute, **next to the variant** — one place, one language, one owner" — `:39`
>
> "**A new error variant is a three-line obligation in one file**: the variant, its `#[error(…)]`
> sentence, and its arms in `kind()` and the `From` match" — `:78`

`:39` defines its own "one place" as *next to the variant*; "one language" is English-vs-`kind`, "one
owner" is Rust-vs-frontend. `:78`'s colon enumerates **one variant's** four edits, so "in one file"
quantifies over that enumeration and not over the repository — and `:111-113` says the
exhaustive-matching thing is a property of "each **enum's** `kind()` match and its `From` match". The
ADR then says the **opposite** of a file rule twice, in its own 2026-10-30 amendment: *"The error
type is chosen by the wire, not by the file"* (`:94`) and *"The discriminator is the wire surface a
command answers on, never the module it is declared in"* (`:105`). The frozen-kind table at
`:117-123` is keyed on the error type and names no path at all.

The load-bearing half — "the derive stays off" — is a coherence-and-exhaustiveness property for the
same reason. With no `Serialize` on the enum, Tauri's blanket `impl<T: Serialize> From<T> for
InvokeError` cannot apply, so a command returning `Result<_, FamilyError>` has no implicit conversion
and does not compile unless the hand-written impl exists; and that impl's payload match and the
`kind()` match are exhaustive with no catch-all arm. Both matches are written **over the enum**, and
an enum's `thiserror::Error` attribute and its impls must live in the crate that defines it, so the
property attaches to the enum plus its two matches wherever the enum is declared. It survives any
layout that keeps **enum + `kind()` + `From` together**, which is what a per-family split does.

**The one layout that would weaken it is forbidden here.** A shared `wire.rs` holding all twelve
`impl From<…> for tauri::ipc::InvokeError` — separating each family's wire arm from its own enum — is
legal Rust, **keeps** the compile error, and destroys the "`next to the variant`" locality `:39`
actually requires: the sentence, the `kind()` arm and the payload arm for one variant would sit in
different files, and the failure this ADR was written to end is precisely the payload nobody had to
think about. Nothing forbade that shape before this paragraph. It does not satisfy this ADR, whatever
directory layout a future proposal picks.

### This ADR is not a one-file rule, and two living docs say that it is

`docs/features/godfile-decomposition-closeout.md:116` records the decline as *"ADR 0063 wants one
file to own the IPC error English"*, and
`docs/research/production-godfile-census-and-the-size-metric.md:319` counts against the split *"ADR
0063's guarantee that a new variant's user-facing English lands in **one** file"*. Both are false as
readings of this file, on the quotes above; a reader who tests either will find it does not hold, and
the honest reading is the one in the preceding sub-section — one hand-written `From` impl per error
type, no `Serialize` derive, both matches exhaustive, the sentence beside its variant. The correction
belongs to those two docs and not to this file — an ADR amends itself and does not rewrite what cites
it — and they carry the `last-verified:` apparatus that makes correcting them routine. The census's
own deferral condition is met by this section: its unresolved-contradiction item `2` deferred the
question *"unless the 'one place owns the error English' guarantee is explicitly re-affirmed
per-family"*, and that is what the sub-section above does.

**The decline stands anyway, and it never rested on this ADR.** What carries it is coherence plus
payoff: `docs/features/improvement-boundary-residue-closeout.md:267` (*"its ten families share
`InvokeErrorExt` and are coherent; splitting buys a directory and nothing else"*) and
`docs/reviews/2026-11-07-codebase-improvement.md:369` (*"splitting buys an `errors/` directory and
nothing else"*) are benefit-claims, and benefit-claims are the kind a measurement can re-examine.
This time the measurement confirmed them.

### The file header's "out of it" is broader than the reason attached to it, and it is being re-worded

`src-tauri/src/agent/errors.rs:12-14` reads *"So do NOT split this file by layer, and do NOT move an
IPC family out of it with the argument that it belongs next to its callers."* Read against its own
reason clause one sentence earlier — *"`DbError`/`FsError` stay with their own layers (`storage` /
the crate's `fs_backend.rs`) because they are NOT IPC types — the wire contract fixes the envelope,
and the error type is chosen by the WIRE, not by the file"* (`:9-11`) — what the clause reaches is
the **non-IPC-layer** move: a family leaving the IPC file for `storage`, for `fs_backend`, or for
`commands/` beside the command that constructs it. An `errors/` sibling changes no layer and gains no
non-IPC home, so the reason does not reach it. The counter-reading is stated here so it is not
quietly suppressed: "out of **it**" read as *this file* rather than *this layer* does forbid a
per-family split, on letter alone. That is the one sentence in the whole corpus that can be read as
prohibiting the move — and **a file header is not an ADR**, so the layout rule that actually governs
here is `:94`/`:105`: the wire chooses the type, never the module. The header is being re-worded to
say what its reason clause supports (do not move an IPC family to a non-IPC layer), with a pointer
back to this amendment for the per-family decision.

### The split stays declined: the cost case measured empty on every axis

Four candidate costs were measured and none is supported. **Defects:** 0 of 87 audit findings and 0
of 61–76 known-gaps entries attribute a defect to file length. **Churn:** 16 commits in twelve
months, one of them a `fix:`, and a fix density of **2.01 per kLOC against a repo line-weighted
average of 1.98** — rank 46 of 115, dead median. **Review size:** median diff **58.5 LOC against a
repo median commit of 358**. **Agent context:** 18.5k tokens, 4.5×–19× below the four files the
census names as expensive (40k/51k/72k/83k). Against that, the payoff is twelve files averaging ~41
production code lines each, largest 94, five of them under 32 — plus two costs the split would newly
incur: `trait InvokeErrorExt` (`errors.rs:538`, five users) is file-private today and would have to
widen and move, and **14 `errors.rs:<N>` prose citations would rot**, 3 of them in production source,
where no compiler or test catches a stale line number. The file's production half is 497 code lines,
already under the 1,000 bar; the 1,135 the ledger carries is 56% inline tests.

**The one real cost the file's shape enables is a missing gate, not a long file** — and it gets worse
per family, not better, as the count of files grows. See the next sub-section.

### The `kind`-spelling gate is now an obligation of this contract

Twelve families carry a `From … for tauri::ipc::InvokeError` at HEAD, and that impl — not a name
suffix — is what makes something an IPC error family under this ADR. As of this amendment, each must
be gated:

- **Nine variant-bearing families** (`SessionError`, `HistoryError`, `AttentionError`,
  `ClipboardError`, `SettingsError`, `SpacesError`, `TasksError`, `McpError`, `AgentsError`) are
  gated by an **exhaustive `match`** over their own variants, one entry per variant supplying both
  the frozen spelling and its construction, so "arm added, construction forgotten" is not expressible
  and a new variant is a compile error in the gate.
- **`OpenError` and `UpdateError`** are gated through their `kind_of` code tables (`:372-384`,
  `:451-472`), whose vocabularies are already frozen by `open_error_kind_of_maps_the_refusal_codes`
  and `update_error_kind_of_maps_the_frozen_code_table`. `OpenError` has exactly one variant and
  `UpdateError` is a tuple struct with none, so an exhaustive `match` over each has one arm and the
  property is vacuous by construction there. Those two pins are deliberately not duplicated.
- **`FilesError` is exempt, with its reason**: it has a `From` impl and no `kind()` method, by the
  decision recorded at `errors.rs:512-520` — *"Do not 'fix' the inconsistency by adding a method
  nothing calls."*

The gate is `src-tauri/tests/error_wire_gate.rs`, added beside this amendment, and it lives outside
`errors.rs` because that file is ledgered at 1135 code lines and the ratchet fails on growth, so a
pin added inside it would redden the guard. Why the obligation is not decorative: rewriting a Rust
arm to `SettingsError::McpAuthFailed(_) => "mcp_auth_faild"` — a real typo — passed **1,651 Rust
tests and a clean `tsc`** (`docs/features/improvement-correctness-seams-closeout.md:264-279`), and
the pin named there as a required step, `settings_error_kind_spellings_are_frozen`, still does not
exist at HEAD.

**Correcting `:127`, from here and not in place.** The 2026-10-30 amendment justifies
`AttentionError`'s family-prefixed kinds with *"one frontend union holds every family's kinds"*. That
sentence is present tense and false at HEAD: `src/lib/errors.ts` was deleted (F7 —
`docs/features/improvement-boundary-residue-closeout.md:245`) and no TypeScript union over the kinds
exists anywhere in `src/` today. It is left standing above as written and corrected here, per the
convention ADR 0016 states, because it is the record of what was true when that choice was taken. The
**reason survives the artifact**: `kind` is a supporter-quotable identifier and a bare `empty_body`
does not say which wire it came from, and that argument does not need a frontend union to hold it.
The single-source-of-truth claim in the header (`errors.rs:18-21`) is unaffected — one definition per
`kind` is unchanged — and nothing outside `errors.rs` branches on a `kind` value from a union; the 83
non-test `.kind` sites in `src/` branch on strings, which is exactly why the gate above is the
enforcement rather than a type.
