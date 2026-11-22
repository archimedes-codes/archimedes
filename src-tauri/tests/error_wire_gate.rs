//! The error-wire gate: an unpinned IPC error family, and an unpinned new
//! variant, must be impossible to land.
//!
//! # Why this file is OUTSIDE `src-tauri/src/agent/errors.rs`
//!
//! `errors.rs` is baselined at **1135** code lines in
//! `scripts/file-size-baseline.txt`, and `scripts/check-file-size.sh` fails on
//! `measured_count > baseline_count` — so that file may not gain ONE code line,
//! and an inline `#[cfg(test)]` region counts toward that number. A pin written
//! inside `errors.rs` reddens the ratchet, which is why the gate lives here, in
//! `src-tauri/tests/`. **ADR 0112 superseded the other half of the reason this
//! comment used to give** — the walk used to RETIRE `*/tests/*` entirely, and the
//! function that did it carried a name saying so. Both are gone:
//! the walk (`walk_tracked_files`) now classifies a test source as its own
//! governed class, gated and seeded at 1,000 code lines against
//! `scripts/file-size-baseline-test.txt`, so a gate placed in this directory is
//! governed rather than invisible. Placement is therefore correct AND permanent:
//! this file is under the test gate, `errors.rs` is not, and moving a pin the
//! other way would still redden the production ratchet.
//!
//! # What this file adds over the pins already in `errors.rs`
//!
//! Five families carry a dedicated frozen-vocabulary pin of their own
//! (`history_error_kind_spellings_are_frozen`, `attention_error_kind_spellings_are_frozen`,
//! `clipboard_error_kind_spellings_are_frozen`, `open_error_kind_of_maps_the_refusal_codes`,
//! `update_error_kind_of_maps_the_frozen_code_table`). **Every one of them builds
//! its expected list by iterating its own hand-written table**, so a newly added
//! variant never enters it — the pin cannot see the thing it claims to catch. And
//! four families (`SettingsError`, `SpacesError`, `McpError`, `AgentsError`) have
//! the MAJORITY of their spellings asserted nowhere: the pin named as a required
//! step in `docs/features/improvement-correctness-seams-closeout.md:240`,
//! `settings_error_kind_spellings_are_frozen`, never landed. The consequence is
//! measured in that same document: a real typo, `"mcp_auth_faild"`, passed 1,651
//! green Rust tests plus a clean `tsc`.
//!
//! # The shape, and why it is a macro
//!
//! One `family_gate!` entry supplies **the match pattern, the frozen spelling and
//! the construction from the same list**, so "the arm was added and the
//! construction was forgotten" is not expressible. Three simpler shapes were
//! compiled first and all three pass vacuously:
//!
//!   * a `match` that merely RETURNS the constructed value does not destructure
//!     its scrutinee, so it cannot be non-exhaustive — a new variant compiles;
//!   * a `visit` closure with an exhaustive inner `match` plus SEPARATELY written
//!     `visit(…)` calls does emit `E0004`, but the set of calls is tied to
//!     nothing: add the variant, its `kind()` arm and the gate arm, omit the call,
//!     and you get 12 rows against a 12-entry literal — green;
//!   * a single `_` entry absorbs every variant, and one row satisfies the file.
//!
//! The third is why the pattern set is policed by an assertion and not by a
//! comment: `$pat:pat` accepts `_`, and a `_` row gives `f.len() == 1` against a
//! 7-entry expectation. So EVERY gate asserts its own row count, and no entry in
//! this file is `_` or an or-pattern. Entry order is load-bearing too — the
//! vocabulary assertion is an ORDERED `Vec` equality, and for all nine families
//! enum declaration order and `kind()` arm order are identical, so transcribing
//! either in source order is correct.
//!
//! Arm B has the same disease and the same cure. A hand-written list of the
//! twelve families reads green with **zero** gates in the file. So the gated set
//! is DERIVED: the file `include_str!`s its own source and scans it for
//! `family_gate!` invocations. Deleting one gate turns the suite red naming that
//! family, which is the proof that arm B is not a rubber stamp.
//!
//! # What this file deliberately does NOT do
//!
//! It does not gate `FilesError`, `OpenError` or `UpdateError`, and each
//! exemption is argued at `EXEMPT_FAMILIES` below rather than asserted silently.
//! It does not duplicate the two `kind_of` code-table pins. It imports the nine
//! types by path (`archimedes_lib::agent::errors::…`), NOT through
//! `agent/mod.rs`'s re-export barrel, which re-exports only seven of the twelve.
//! It carries NO platform gate: `tests/ipc.rs` has a `#![cfg(target_os =
//! "linux")]` because the Tauri MOCK RUNTIME segfaults on macOS, and this file
//! uses only `tauri::ipc::InvokeError` and never `tauri::test`, so copying that
//! header would silently stop guarding macOS and Windows. And it claims no
//! TypeScript mirror — `src/lib/errors.ts` is deleted and no TS union exists at
//! HEAD; the honest statement is the `errors.rs` header: Rust's `kind()` strings
//! are the single source of truth.

use std::collections::BTreeSet;

use archimedes_lib::agent::errors::{
    AgentsError, AttentionError, ClipboardError, HistoryError, McpError, SessionError,
    SettingsError, SpacesError, TasksError,
};

/// One family gate. `$ty` is a parameter so ONE macro serves all nine families,
/// and a single entry per variant supplies the pattern, the frozen spelling and
/// the construction together — they cannot diverge, because they are one row.
///
/// Invoke this INSIDE the `#[test]` fn. `frozen()` is an `fn` ITEM, and items do
/// not capture their environment, so a `$make` that referenced a binding from
/// the test body would be `error[E0434]`; every `$make` here is self-contained
/// (inline literals, struct literals, or calls). Invoking inside the fn scopes
/// the name `frozen` to that fn, which is what lets nine expansions of one macro
/// coexist in one file.
macro_rules! family_gate {
    ($ty:ty, $($pat:pat => ($spelling:expr, $make:expr)),+ $(,)?) => {
        fn frozen() -> Vec<(&'static str, $ty)> {
            // no catch-all arm on purpose: a new variant is E0004 here
            let spell = |e: &$ty| -> &'static str { match e { $($pat => $spelling,)+ } };
            let all: Vec<$ty> = vec![$($make),+];
            all.into_iter().map(|e| (spell(&e), e)).collect()
        }
    };
}

// ── arm A ────────────────────────────────────────────────────────────────────
//
// The NINE variant-bearing families. Each gate: (1) asserts its own row count,
// (2) compares the vocabulary against an INDEPENDENT hand-written literal in
// declaration order, (3) re-checks every row's spelling against `kind()` — that
// loop is what catches a re-worded `kind()` arm, and it is non-redundant because
// the expected literal above does not come from `kind()` — and (4) checks the
// ADR 0063 envelope per variant.
//
// `OpenError` and `UpdateError` are absent on purpose: one variant and zero
// variants respectively, so an exhaustive `match` over each has one arm and the
// `E0004` property is vacuous by construction. Their vocabularies are frozen by
// their own `kind_of` pins (`errors.rs:1526`, `:1577`), which are not duplicated
// here.

/// `SessionError` — 7 variants (`errors.rs:43`), spellings in declaration order.
#[test]
fn session_error_kinds_are_frozen_and_complete() {
    family_gate!(SessionError,
        SessionError::Io(_)               => ("io",                SessionError::Io("disk went away".into())),
        SessionError::Command { .. }      => ("command",           SessionError::Command { error: "the command exited 1".into() }),
        SessionError::UnknownSession { .. } => ("unknown_session", SessionError::UnknownSession { id: "ses_01".into() }),
        SessionError::NotResumable { .. } => ("not_resumable",     SessionError::NotResumable { id: "ses_02".into() }),
        SessionError::FolderMissing { .. } => ("folder_missing",   SessionError::FolderMissing { path: "/no/such/dir".into() }),
        SessionError::InvalidPrompt { .. } => ("invalid_prompt",   SessionError::InvalidPrompt { reason: "image mime type not allowed".into() }),
        SessionError::SettleTimeout { .. } => ("settle_timeout",   SessionError::SettleTimeout { detail: "no settle within the turn bound".into() }),
    );

    let f = frozen();
    assert_eq!(f.len(), 7, "one macro entry per variant");
    let spelled: Vec<&'static str> = f.iter().map(|(_, e)| e.kind()).collect();
    assert_eq!(
        spelled,
        vec![
            "io",
            "command",
            "unknown_session",
            "not_resumable",
            "folder_missing",
            "invalid_prompt",
            "settle_timeout",
        ],
        "the SessionError `kind` vocabulary is frozen, in enum declaration order"
    );
    for (exp, e) in &f {
        assert_eq!(&e.kind(), exp, "frozen spelling for {e:?}");
        let wire = tauri::ipc::InvokeError::from(e.clone()).0;
        assert!(
            wire.is_object(),
            "{e:?} must reach the wire as an object, got {wire}"
        );
        assert_eq!(wire["kind"].as_str(), Some(*exp), "kind key for {e:?}");
        assert_eq!(
            wire["message"].as_str(),
            Some(e.to_string().as_str()),
            "message for {e:?} must be the Display sentence"
        );
        let message = wire["message"].as_str().unwrap_or_default();
        assert!(
            !message.is_empty(),
            "`message` must be non-empty for {e:?}: {wire}"
        );
    }
}

/// `HistoryError` — 3 variants (`errors.rs:156`).
#[test]
fn history_error_kinds_are_frozen_and_complete() {
    family_gate!(HistoryError,
        HistoryError::Sqlite(_) => ("sqlite", HistoryError::Sqlite("no such table".into())),
        HistoryError::Io(_)     => ("io",     HistoryError::Io("disk went away".into())),
        HistoryError::Json(_)   => ("json",   HistoryError::Json("bad payload".into())),
    );

    let f = frozen();
    assert_eq!(f.len(), 3, "one macro entry per variant");
    let spelled: Vec<&'static str> = f.iter().map(|(_, e)| e.kind()).collect();
    assert_eq!(
        spelled,
        vec!["sqlite", "io", "json"],
        "the HistoryError `kind` vocabulary is frozen, in enum declaration order"
    );
    for (exp, e) in &f {
        assert_eq!(&e.kind(), exp, "frozen spelling for {e:?}");
        let wire = tauri::ipc::InvokeError::from(e.clone()).0;
        assert!(
            wire.is_object(),
            "{e:?} must reach the wire as an object, got {wire}"
        );
        assert_eq!(wire["kind"].as_str(), Some(*exp), "kind key for {e:?}");
        assert_eq!(
            wire["message"].as_str(),
            Some(e.to_string().as_str()),
            "message for {e:?} must be the Display sentence"
        );
        let message = wire["message"].as_str().unwrap_or_default();
        assert!(
            !message.is_empty(),
            "`message` must be non-empty for {e:?}: {wire}"
        );
    }
}

/// `AttentionError` — 2 unit variants (`errors.rs:237`).
#[test]
fn attention_error_kinds_are_frozen_and_complete() {
    family_gate!(AttentionError,
        AttentionError::EmptyBody => ("attention_empty_body", AttentionError::EmptyBody),
        AttentionError::NoRuntime => ("attention_no_runtime", AttentionError::NoRuntime),
    );

    let f = frozen();
    assert_eq!(f.len(), 2, "one macro entry per variant");
    let spelled: Vec<&'static str> = f.iter().map(|(_, e)| e.kind()).collect();
    assert_eq!(
        spelled,
        vec!["attention_empty_body", "attention_no_runtime"],
        "the AttentionError `kind` vocabulary is frozen, in enum declaration order"
    );
    for (exp, e) in &f {
        assert_eq!(&e.kind(), exp, "frozen spelling for {e:?}");
        let wire = tauri::ipc::InvokeError::from(e.clone()).0;
        assert!(
            wire.is_object(),
            "{e:?} must reach the wire as an object, got {wire}"
        );
        assert_eq!(wire["kind"].as_str(), Some(*exp), "kind key for {e:?}");
        assert_eq!(
            wire["message"].as_str(),
            Some(e.to_string().as_str()),
            "message for {e:?} must be the Display sentence"
        );
        let message = wire["message"].as_str().unwrap_or_default();
        assert!(
            !message.is_empty(),
            "`message` must be non-empty for {e:?}: {wire}"
        );
    }
}

/// `ClipboardError` — 2 variants (`errors.rs:296`).
#[test]
fn clipboard_error_kinds_are_frozen_and_complete() {
    family_gate!(ClipboardError,
        ClipboardError::Clipboard(_) => ("clipboard", ClipboardError::Clipboard("clipboard busy".into())),
        ClipboardError::Encode(_)    => ("encode",    ClipboardError::Encode("png cap exceeded".into())),
    );

    let f = frozen();
    assert_eq!(f.len(), 2, "one macro entry per variant");
    let spelled: Vec<&'static str> = f.iter().map(|(_, e)| e.kind()).collect();
    assert_eq!(
        spelled,
        vec!["clipboard", "encode"],
        "the ClipboardError `kind` vocabulary is frozen, in enum declaration order"
    );
    for (exp, e) in &f {
        assert_eq!(&e.kind(), exp, "frozen spelling for {e:?}");
        let wire = tauri::ipc::InvokeError::from(e.clone()).0;
        assert!(
            wire.is_object(),
            "{e:?} must reach the wire as an object, got {wire}"
        );
        assert_eq!(wire["kind"].as_str(), Some(*exp), "kind key for {e:?}");
        assert_eq!(
            wire["message"].as_str(),
            Some(e.to_string().as_str()),
            "message for {e:?} must be the Display sentence"
        );
        let message = wire["message"].as_str().unwrap_or_default();
        assert!(
            !message.is_empty(),
            "`message` must be non-empty for {e:?}: {wire}"
        );
    }
}

/// `SettingsError` — 12 variants (`errors.rs:550`). The family the measured typo
/// escaped in, and the family whose promised pin never landed.
/// `UnknownSearchProvider` is the only two-field variant.
#[test]
fn settings_error_kinds_are_frozen_and_complete() {
    family_gate!(SettingsError,
        SettingsError::SaveFailed(_)              => ("save_failed",             SettingsError::SaveFailed("read-only store".into())),
        SettingsError::InvalidMcpServer(_)        => ("invalid_mcp_server",      SettingsError::InvalidMcpServer("missing command".into())),
        SettingsError::McpTestFailed(_)           => ("mcp_test_failed",         SettingsError::McpTestFailed("handshake refused".into())),
        SettingsError::McpAuthFailed(_)           => ("mcp_auth_failed",         SettingsError::McpAuthFailed("token rejected".into())),
        SettingsError::UnknownSearchProvider(_, _) => ("unknown_search_provider", SettingsError::UnknownSearchProvider("brave".into(), "google, bing".into())),
        SettingsError::SearchNotConfigured(_)     => ("search_not_configured",   SettingsError::SearchNotConfigured("google".into())),
        SettingsError::SearchTimeout(_)           => ("search_timeout",          SettingsError::SearchTimeout("bing".into())),
        SettingsError::SearchFailed(_)            => ("search_failed",           SettingsError::SearchFailed("connection reset".into())),
        SettingsError::InvalidOidcConfig(_)       => ("invalid_oidc_config",     SettingsError::InvalidOidcConfig("issuer missing".into())),
        SettingsError::OidcAuthFailed(_)          => ("oidc_auth_failed",        SettingsError::OidcAuthFailed("callback timed out".into())),
        SettingsError::OidcStoreFailed(_)         => ("oidc_store_failed",       SettingsError::OidcStoreFailed("0600 write failed".into())),
        SettingsError::Other(_)                   => ("other",                   SettingsError::Other("something else".into())),
    );

    let f = frozen();
    assert_eq!(f.len(), 12, "one macro entry per variant");
    let spelled: Vec<&'static str> = f.iter().map(|(_, e)| e.kind()).collect();
    assert_eq!(
        spelled,
        vec![
            "save_failed",
            "invalid_mcp_server",
            "mcp_test_failed",
            "mcp_auth_failed",
            "unknown_search_provider",
            "search_not_configured",
            "search_timeout",
            "search_failed",
            "invalid_oidc_config",
            "oidc_auth_failed",
            "oidc_store_failed",
            "other",
        ],
        "the SettingsError `kind` vocabulary is frozen, in enum declaration order"
    );
    for (exp, e) in &f {
        assert_eq!(&e.kind(), exp, "frozen spelling for {e:?}");
        let wire = tauri::ipc::InvokeError::from(e.clone()).0;
        assert!(
            wire.is_object(),
            "{e:?} must reach the wire as an object, got {wire}"
        );
        assert_eq!(wire["kind"].as_str(), Some(*exp), "kind key for {e:?}");
        assert_eq!(
            wire["message"].as_str(),
            Some(e.to_string().as_str()),
            "message for {e:?} must be the Display sentence"
        );
        let message = wire["message"].as_str().unwrap_or_default();
        assert!(
            !message.is_empty(),
            "`message` must be non-empty for {e:?}: {wire}"
        );
    }
}

/// `SpacesError` — 4 variants (`errors.rs:634`).
#[test]
fn spaces_error_kinds_are_frozen_and_complete() {
    family_gate!(SpacesError,
        SpacesError::FolderNotFound(_) => ("folder_not_found", SpacesError::FolderNotFound("/no/such/folder".into())),
        SpacesError::NotAFolder(_)     => ("not_a_folder",     SpacesError::NotAFolder("/etc/hosts".into())),
        SpacesError::Database(_)       => ("database",         SpacesError::Database("table spaces is missing".into())),
        SpacesError::Other(_)          => ("other",            SpacesError::Other("something else".into())),
    );

    let f = frozen();
    assert_eq!(f.len(), 4, "one macro entry per variant");
    let spelled: Vec<&'static str> = f.iter().map(|(_, e)| e.kind()).collect();
    assert_eq!(
        spelled,
        vec!["folder_not_found", "not_a_folder", "database", "other"],
        "the SpacesError `kind` vocabulary is frozen, in enum declaration order"
    );
    for (exp, e) in &f {
        assert_eq!(&e.kind(), exp, "frozen spelling for {e:?}");
        let wire = tauri::ipc::InvokeError::from(e.clone()).0;
        assert!(
            wire.is_object(),
            "{e:?} must reach the wire as an object, got {wire}"
        );
        assert_eq!(wire["kind"].as_str(), Some(*exp), "kind key for {e:?}");
        assert_eq!(
            wire["message"].as_str(),
            Some(e.to_string().as_str()),
            "message for {e:?} must be the Display sentence"
        );
        let message = wire["message"].as_str().unwrap_or_default();
        assert!(
            !message.is_empty(),
            "`message` must be non-empty for {e:?}: {wire}"
        );
    }
}

/// `TasksError` — 6 variants (`errors.rs:695`). `EmptyTitle` is the unit variant;
/// `ArtifactTooLarge` is the struct variant.
#[test]
fn tasks_error_kinds_are_frozen_and_complete() {
    family_gate!(TasksError,
        TasksError::Database(_)           => ("database",          TasksError::Database("table tasks is locked".into())),
        TasksError::NotFound(_)           => ("not_found",         TasksError::NotFound("no task with id tsk_01".into())),
        TasksError::EmptyTitle            => ("empty_title",       TasksError::EmptyTitle),
        TasksError::BadArtifactKey(_)     => ("bad_artifact_key",  TasksError::BadArtifactKey("Bad Key!".into())),
        TasksError::ArtifactTooLarge { .. } => ("artifact_too_large", TasksError::ArtifactTooLarge { size: 300_000, max: 262_144 }),
        TasksError::Other(_)              => ("other",             TasksError::Other("something else".into())),
    );

    let f = frozen();
    assert_eq!(f.len(), 6, "one macro entry per variant");
    let spelled: Vec<&'static str> = f.iter().map(|(_, e)| e.kind()).collect();
    assert_eq!(
        spelled,
        vec![
            "database",
            "not_found",
            "empty_title",
            "bad_artifact_key",
            "artifact_too_large",
            "other",
        ],
        "the TasksError `kind` vocabulary is frozen, in enum declaration order"
    );
    for (exp, e) in &f {
        assert_eq!(&e.kind(), exp, "frozen spelling for {e:?}");
        let wire = tauri::ipc::InvokeError::from(e.clone()).0;
        assert!(
            wire.is_object(),
            "{e:?} must reach the wire as an object, got {wire}"
        );
        assert_eq!(wire["kind"].as_str(), Some(*exp), "kind key for {e:?}");
        assert_eq!(
            wire["message"].as_str(),
            Some(e.to_string().as_str()),
            "message for {e:?} must be the Display sentence"
        );
        let message = wire["message"].as_str().unwrap_or_default();
        assert!(
            !message.is_empty(),
            "`message` must be non-empty for {e:?}: {wire}"
        );
    }
}

/// `McpError` — 4 variants (`errors.rs:875`).
#[test]
fn mcp_error_kinds_are_frozen_and_complete() {
    family_gate!(McpError,
        McpError::LoadFailed(_) => ("load_failed", McpError::LoadFailed("config unreadable".into())),
        McpError::NotFound(_)   => ("not_found",   McpError::NotFound("srv_missing".into())),
        McpError::Failed(_)     => ("failed",      McpError::Failed("tool call rejected".into())),
        McpError::Other(_)      => ("other",       McpError::Other("something else".into())),
    );

    let f = frozen();
    assert_eq!(f.len(), 4, "one macro entry per variant");
    let spelled: Vec<&'static str> = f.iter().map(|(_, e)| e.kind()).collect();
    assert_eq!(
        spelled,
        vec!["load_failed", "not_found", "failed", "other"],
        "the McpError `kind` vocabulary is frozen, in enum declaration order"
    );
    for (exp, e) in &f {
        assert_eq!(&e.kind(), exp, "frozen spelling for {e:?}");
        let wire = tauri::ipc::InvokeError::from(e.clone()).0;
        assert!(
            wire.is_object(),
            "{e:?} must reach the wire as an object, got {wire}"
        );
        assert_eq!(wire["kind"].as_str(), Some(*exp), "kind key for {e:?}");
        assert_eq!(
            wire["message"].as_str(),
            Some(e.to_string().as_str()),
            "message for {e:?} must be the Display sentence"
        );
        let message = wire["message"].as_str().unwrap_or_default();
        assert!(
            !message.is_empty(),
            "`message` must be non-empty for {e:?}: {wire}"
        );
    }
}

/// `AgentsError` — 3 variants (`errors.rs:912`).
#[test]
fn agents_error_kinds_are_frozen_and_complete() {
    family_gate!(AgentsError,
        AgentsError::DiscoveryFailed(_) => ("discovery_failed", AgentsError::DiscoveryFailed("no skills dir".into())),
        AgentsError::NotFound(_)        => ("not_found",        AgentsError::NotFound("explore".into())),
        AgentsError::Other(_)           => ("other",            AgentsError::Other("something else".into())),
    );

    let f = frozen();
    assert_eq!(f.len(), 3, "one macro entry per variant");
    let spelled: Vec<&'static str> = f.iter().map(|(_, e)| e.kind()).collect();
    assert_eq!(
        spelled,
        vec!["discovery_failed", "not_found", "other"],
        "the AgentsError `kind` vocabulary is frozen, in enum declaration order"
    );
    for (exp, e) in &f {
        assert_eq!(&e.kind(), exp, "frozen spelling for {e:?}");
        let wire = tauri::ipc::InvokeError::from(e.clone()).0;
        assert!(
            wire.is_object(),
            "{e:?} must reach the wire as an object, got {wire}"
        );
        assert_eq!(wire["kind"].as_str(), Some(*exp), "kind key for {e:?}");
        assert_eq!(
            wire["message"].as_str(),
            Some(e.to_string().as_str()),
            "message for {e:?} must be the Display sentence"
        );
        let message = wire["message"].as_str().unwrap_or_default();
        assert!(
            !message.is_empty(),
            "`message` must be non-empty for {e:?}: {wire}"
        );
    }
}

// ── arm B ────────────────────────────────────────────────────────────────────
//
// The family scan. Keyed on `impl From<…> for tauri::ipc::InvokeError`, which IS
// the definition of "IPC error family" (ADR 0063), and NOT on a name suffix — a
// `^pub (enum|struct) [A-Za-z]*Error` scan misses a family not suffixed `Error`,
// misses `pub(crate)`, and cannot see a removed `From`. That weaker count is kept
// below as a SECONDARY assert only.

/// The three families arm A does not gate, each with its reason. A family may
/// not be moved in here quietly: the gate asserts `gated ∩ exempt == ∅` and
/// `gated.len() == 9`, so adding a name here without deleting its gate is red,
/// and deleting a gate without adding a name here is red too.
const EXEMPT_FAMILIES: &[(&str, &str)] = &[
    (
        "FilesError",
        "has a `From` impl but no `kind()`. errors.rs:512-520: \"`FilesError` \
         deliberately has NO `kind()` method … Do not 'fix' the inconsistency by \
         adding a method nothing calls.\" Its kind is discriminated INLINE by the \
         `From` impl, which is the only reader of that discrimination, so there is \
         no vocabulary for a gate to freeze. This is an exemption, not a violation.",
    ),
    (
        "OpenError",
        "no variants to be exhaustive over beyond `Code(String)`, so an \
         exhaustive `match` has one arm and the E0004 property is vacuous by \
         construction. Vocabulary frozen by `kind_of`: \
         `open_error_kind_of_maps_the_refusal_codes` (errors.rs:1526).",
    ),
    (
        "UpdateError",
        "a tuple struct with NO variants, so the E0004 property is vacuous by \
         construction. Vocabulary frozen by `kind_of`: \
         `update_error_kind_of_maps_the_frozen_code_table` (errors.rs:1577).",
    ),
];

/// The `NAME` of every `impl From<NAME> for tauri::ipc::InvokeError` at column 0.
fn from_impl_families(source: &str) -> BTreeSet<String> {
    source
        .lines()
        .filter_map(|line| {
            let rest = line.strip_prefix("impl From<")?;
            let (name, tail) = rest.split_once("> for ")?;
            if tail.split_whitespace().next() == Some("tauri::ipc::InvokeError") {
                Some(name.to_string())
            } else {
                None
            }
        })
        .collect()
}

/// The `NAME` of every `family_gate!` invocation in the gate's OWN source. This
/// is what makes arm B a gate and not a list: the set is read out of the file, so
/// a family that is no longer gated is no longer in it.
///
/// The scan runs over `code_only`, not the raw text: an invocation that has been
/// commented out is a MENTION and must not be counted, or arm B reads green while
/// that family's checks no longer run.
fn gated_families(gate_source: &str) -> BTreeSet<String> {
    const CALL: &str = "family_gate!(";
    let code = code_only(gate_source);
    code.match_indices(CALL)
        .filter_map(|(at, _)| {
            let tail = &code[at + CALL.len()..];
            let name: String = tail
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            if name.is_empty() {
                None
            } else {
                Some(name)
            }
        })
        .collect()
}

/// The scan below reads the gate's own text, so it must read CODE and not prose:
/// a `family_gate!` inside a comment, a doc comment, or a string literal is a
/// mention, not an invocation. Without this, commenting out a family's test keeps
/// its name in `gated`, and arm B's missing-family and count checks still pass
/// while that family's checks no longer run — a green that is a lie.
///
/// Returns `source` with every comment removed and every string/char literal's
/// CONTENTS removed (the delimiters are dropped too, so a `family_gate!(` cannot
/// be reassembled across a boundary). Line comments, nesting block comments,
/// raw strings with any number of hashes, escape-bearing literals and lifetimes
/// are all distinguished; a lifetime emits its `'` because it is code.
fn code_only(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len());
    let mut i = 0usize;
    let mut block_depth = 0usize;

    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();

        if block_depth > 0 {
            // Rust block comments NEST, so a naive "find the first */" ends the
            // outer comment at the inner one and resurrects the tail as code.
            if c == '/' && next == Some('*') {
                block_depth += 1;
                i += 2;
            } else if c == '*' && next == Some('/') {
                block_depth -= 1;
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }

        if c == '/' && next == Some('/') {
            // Skip to end of line, but keep the newline: dropping it would splice
            // the next line onto this one and could join two tokens.
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && next == Some('*') {
            block_depth += 1;
            i += 2;
        } else if c == 'r' && (next == Some('"') || next == Some('#')) {
            // Raw string: r"…" or r#"…"#. Contents are data, never code.
            let mut hashes = 0usize;
            let mut j = i + 1;
            while chars.get(j) == Some(&'#') {
                hashes += 1;
                j += 1;
            }
            if chars.get(j) == Some(&'"') {
                j += 1;
                loop {
                    match chars.get(j) {
                        None => {
                            j = chars.len();
                            break;
                        }
                        Some('"') => {
                            let mut k = j + 1;
                            let mut h = 0usize;
                            while h < hashes && chars.get(k) == Some(&'#') {
                                h += 1;
                                k += 1;
                            }
                            if h == hashes {
                                j = k;
                                break;
                            }
                            j += 1;
                        }
                        Some(_) => j += 1,
                    }
                }
                i = j;
            } else {
                // `r#` / a bare `r` that is not a raw-string opener: ordinary code.
                out.push(c);
                i += 1;
            }
        } else if c == '"' {
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                if chars[i] == '\\' {
                    i += 1; // the escaped char is consumed with its backslash
                }
                i += 1;
            }
            i += 1; // the closing quote (clamped if the literal is unterminated)
            i = i.min(chars.len());
        } else if c == '\'' && (next == Some('\\') || chars.get(i + 2) == Some(&'\'')) {
            // A char literal ('a', '\n', '\'', '\u{1F600}') — as opposed to a
            // lifetime `'a`, which is code and falls through to the `else`.
            let mut j = i + 1;
            while j < chars.len() {
                if chars[j] == '\\' {
                    j += 2; // skip the escape pair, so '\'' does not end early
                    continue;
                }
                if chars[j] == '\'' {
                    break; // the closing quote
                }
                j += 1;
            }
            i = (j + 1).min(chars.len());
        } else {
            out.push(c);
            i += 1;
        }
    }

    out
}

/// The secondary count: `^pub (enum|struct) …Error`. Weaker than the `From` scan
/// (see the note above) and therefore kept as a cross-check, not as the gate.
fn pub_error_type_count(source: &str) -> usize {
    source
        .lines()
        .filter(|line| {
            let head = line
                .strip_prefix("pub enum ")
                .or_else(|| line.strip_prefix("pub struct "));
            match head {
                Some(head) => {
                    let ident: String = head
                        .chars()
                        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                        .collect();
                    ident.ends_with("Error")
                }
                None => false,
            }
        })
        .count()
}

/// Arm B: every IPC error family in `errors.rs` is either gated by arm A or
/// carries a documented exemption — and the gated set is DERIVED from this file's
/// own text, so the gate cannot read green while gating one family fewer.
#[test]
fn every_ipc_error_family_has_a_gate_entry() {
    // Both paths resolve relative to THIS file. The second is a self-include:
    // `include_str!` is expanded at compile time, so there is no recursion, and
    // moving this file breaks the first path at compile time — which is the
    // point, a relocated gate silently stops scanning the source it guards.
    let source = include_str!("../src/agent/errors.rs");
    let gate_source = include_str!("error_wire_gate.rs");

    let from_impls = from_impl_families(source);
    let gated = gated_families(gate_source);
    let exempt: BTreeSet<String> = EXEMPT_FAMILIES
        .iter()
        .map(|(name, _)| (*name).to_string())
        .collect();

    // 1. Every family with a `From` impl is gated or exempt. This is the assert
    //    that NAMES an unguarded family, so it runs first.
    let missing: Vec<&str> = from_impls
        .iter()
        .filter(|name| !gated.contains(*name) && !exempt.contains(*name))
        .map(String::as_str)
        .collect();
    assert!(
        missing.is_empty(),
        "IPC error families with an `impl From<…> for tauri::ipc::InvokeError` in \
         src-tauri/src/agent/errors.rs but NO `family_gate!` entry in this file and \
         no documented exemption: {missing:?}. Add a gate: one row per variant, each \
         row giving the match pattern, the frozen `kind()` spelling and a \
         construction, plus an independent vocabulary literal in declaration order, \
         plus `assert_eq!(f.len(), N)`."
    );

    // 2. Nothing gated or exempted is a family that does not exist. Stops a typo
    //    in an exemption (or a renamed gate) from quietly vacating a slot.
    let spurious: Vec<&str> = gated
        .iter()
        .chain(exempt.iter())
        .filter(|name| !from_impls.contains(*name))
        .map(String::as_str)
        .collect();
    assert!(
        spurious.is_empty(),
        "this file names {spurious:?} as gated or exempt, but no \
         `impl From<…> for tauri::ipc::InvokeError` for them exists in \
         src-tauri/src/agent/errors.rs — a removed `From` impl is a wire-contract \
         change, and a renamed one is a family that just stopped being guarded."
    );

    // 3. A family cannot be moved from gated to exempt to dodge its gate.
    let overlap: Vec<&str> = gated
        .iter()
        .filter(|name| exempt.contains(*name))
        .map(String::as_str)
        .collect();
    assert!(
        overlap.is_empty(),
        "{overlap:?} is BOTH gated and exempt; an exemption must be earned by the \
         reason written beside it, not claimed alongside a gate."
    );

    // 4. All nine variant-bearing families are present. Together with 1-3 this is
    //    the set equation `gated ∪ exempt == from_impls`.
    assert_eq!(
        gated.len(),
        9,
        "arm A must gate exactly the nine variant-bearing families; this file's \
         own text currently gates {} — {gated:?}",
        gated.len(),
    );

    // Secondary cross-checks (weaker than the `From` scan; see the note above).
    assert_eq!(
        from_impls.len(),
        12,
        "twelve IPC error families are expected (ADR 0063); found {from_impls:?}"
    );
    assert_eq!(
        pub_error_type_count(source),
        12,
        "the secondary `^pub (enum|struct) …Error` scan must agree with the \
         `From`-impl count"
    );
}

/// The P2 regression: a `family_gate!` that has been commented out is a MENTION,
/// not an invocation. Greptile's scenario, end to end — take this file's real
/// text, comment out one gate exactly as a maintainer would, and the derived set
/// must LOSE that family so arm B's missing-family check goes red naming it.
///
/// Before `code_only` this read 9 gates and stayed green with the `McpError`
/// test disabled: the count check (`gated.len() == 9`) and the missing-family
/// check both passed while `McpError`'s assertions no longer ran.
#[test]
fn a_commented_out_gate_stops_counting() {
    let gate_source = include_str!("error_wire_gate.rs");
    let live = gated_families(gate_source);
    assert!(
        live.contains("McpError"),
        "precondition: this file gates `McpError` today (found {live:?})"
    );

    // Comment the invocation out, leaving everything else — including the gate's
    // body and the surrounding `#[test]` — untouched. The needle is assembled at
    // runtime on purpose: this file `include_str!`s itself, so a literal needle
    // written here would appear in its own source and corrupt the count.
    let needle = format!("    {}({},", "family_gate!", "McpError");
    let replaced = gate_source.replacen(&needle, &format!("    // {}", needle.trim_start()), 1);
    assert_eq!(
        gate_source.matches(&needle).count(),
        1,
        "precondition: the needle must match exactly one live invocation"
    );
    assert_ne!(
        replaced, gate_source,
        "precondition: the substitution must actually change the text"
    );

    let after = gated_families(&replaced);
    assert!(
        !after.contains("McpError"),
        "a commented-out `family_gate!(McpError, …)` must NOT count as a gate; \
         the scan still read {after:?}"
    );
    assert_eq!(
        after.len(),
        live.len() - 1,
        "commenting out one gate must drop the derived count by exactly one"
    );
}

/// The extractor itself, over synthetic text: every non-code spelling of the
/// macro name is skipped, and the one live invocation is found. Kept separate
/// from the test above so a future edit to this file's gates cannot silently
/// invalidate the mechanism's unit proof.
#[test]
fn the_scan_reads_code_and_not_prose() {
    let source = concat!(
        "// family_gate!(LineCommented, A => (\"a\", A::A)),\n",
        "/// family_gate!(DocCommented, A => (\"a\", A::A)),\n",
        "/* family_gate!(BlockCommented, A => (\"a\", A::A)), */\n",
        "/* outer /* family_gate!(NestedCommented, …) */ still a comment */\n",
        "//! family_gate!(ModuleDocCommented, A => (\"a\", A::A)),\n",
        "const CALL: &str = \"family_gate!(StringLiteral, A => (\\\"a\\\", A::A))\";\n",
        "const RAW: &str = r#\"family_gate!(RawString, A => (\"a\", A::A))\"#;\n",
        "const CH: char = '\\''; // a char literal holding a quote\n",
        "fn takes<'a>(x: &'a str) -> &'a str { x } // lifetimes are code\n",
        "    family_gate!(Live, A => (\"a\", A::A)),\n",
    );

    let found = gated_families(source);
    assert_eq!(
        found.iter().collect::<Vec<_>>(),
        vec!["Live"],
        "only the live invocation counts; every comment, doc comment and string \
         literal mention must be skipped (and a char literal must not swallow \
         the code after it)"
    );

    // The extractor's own name must not be counted as an invocation of itself.
    assert!(
        !gated_families(&code_only(source)).contains("CALL"),
        "the string literal holding the search pattern must not yield a name"
    );
}

/// `code_only` keeps code and drops data — asserted directly, because arm B's
/// soundness rests on it and a subtle tokenizer bug would otherwise show up only
/// as a mysteriously green gate.
#[test]
fn code_only_drops_comments_and_literal_contents_only() {
    // Code survives: identifiers, lifetimes, punctuation.
    assert_eq!(
        code_only("fn takes<'a>(x: &'a str) -> &'a str { x }").replace(' ', ""),
        "fntakes<'a>(x:&'astr)->&'astr{x}".to_string()
    );

    // A comment's contents are gone but the line break is preserved, so the next
    // line cannot be spliced onto this one.
    assert_eq!(code_only("a // family_gate!(Nope,\nb"), "a \nb".to_string());

    // A literal's contents are gone; the code around it is not, and a `'` inside
    // a char literal does not swallow the rest of the line.
    assert_eq!(
        code_only("let s = \"family_gate!(Nope,\"; let t = 1;"),
        "let s = ; let t = 1;"
    );
    assert_eq!(
        code_only("let c = '\\''; let t = 1;"),
        "let c = ; let t = 1;"
    );
    assert_eq!(
        code_only("let r = r#\"a\"#family_gate!(Yes, A);"),
        "let r = family_gate!(Yes, A);"
    );

    // Nesting: the outer comment ends at the OUTER `*/`, not the inner one.
    assert_eq!(
        code_only("/* a /* b */ family_gate!(StillCommented, A) */ real!(B)"),
        " real!(B)".to_string()
    );
}
