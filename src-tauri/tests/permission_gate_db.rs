//! The native permission gate's `Db`-backed half, as a TWO-SIDED desktop
//! test (T5/S5a — the relocation the S5 RULING names for `permission.rs`).
//!
//! # Why this file exists
//!
//! `agent/permission.rs` moved into `crates/fulcrum-core` in S5a (it was in
//! S2's scope and S2's commit did not move it — `git show --name-status
//! 27e367cd` shows one rename, not two — and it cannot stay desktop because
//! `harness/loop.rs` and `harness/loop/gate.rs` name it and they move in
//! S5b). Four of its unit tests could not travel with it:
//!
//!   * `#[cfg(test)]` does not survive into an rlib (Step A.4), so a crate
//!     unit test is invisible to the desktop anyway; and
//!   * the crate cannot reach `storage::Db` at all — `rusqlite` is not in its
//!     dependency graph (`DbError` wraps `rusqlite::Error`, Step B-bis), and
//!     reaching `crate::storage` would be the `fulcrum-core →
//!     archimedes_lib` edge that IS the package cycle T5 severs.
//!
//! So these four follow the rule Step D already states for the two-sided
//! tests (`worker_e2e.rs`, `worker_smoke.rs`, `ipc.rs`, the four
//! `harness_*.rs`) and for S2's `skill_catalog_drift.rs`: **a test that spans
//! the boundary lives on the side that can see both halves** — the desktop.
//! They drive the crate's `native_permission_gate` through the DESKTOP's
//! `SqliteTrustSource`, and that pairing is exactly the boundary crossing.
//!
//! This is a RELOCATION, not a rewrite: the fixture, the gate call, and every
//! assertion are verbatim from the moved module. The only edits are the paths
//! the move forces (`crate::` → `archimedes_lib::agent::`, `crate::storage::Db`
//! → `archimedes_lib::storage::Db`, `crate::test_support::ScratchDir` →
//! `archimedes_lib::test_support::ScratchDir`). The scratch-dir prefix stays
//! `perm-gate-` and its census row repoints to THIS file, which is now the
//! single minter (the crate no longer mints it — the fixture left with the
//! tests).
//!
//! # The tests that DID travel
//!
//! The five that touch only the crate's own seam stayed in
//! `crates/fulcrum-core/src/permission.rs`: the two `permission_title`
//! shapes, the no-deadline pin, the two option-list pins and the three
//! serde-pair pins. Nothing was deleted; the count is preserved and the loss
//! check (`cargo test --workspace -- --list`, never a source grep) proves it.
//!
//! # What would make this file wrong
//!
//! If a later step folds these back into the crate, it must first move
//! `storage::Db` or put a persistence trait between the gate and the `Db` —
//! until then a crate-side copy cannot compile, and deleting them here would
//! silently drop the trusted-Space auto-approve and the ADR 0025 "the gate
//! never writes the trust flag" coverage.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use archimedes_lib::agent::harness::trust::SqliteTrustSource;
use archimedes_lib::agent::permission::{
    native_permission_gate, permission_key, permission_options, PendingPermissions,
    PermissionOutcome,
};
use archimedes_lib::agent::EventSink;
use archimedes_lib::storage::Db;
use archimedes_lib::test_support::ScratchDir;

/// A recording `EventSink` (the `permission-request` frames) — verbatim from
/// the moved module's test harness. (`tests/common/rec_sink.rs` holds a
/// near-identical type for the two-sided harness tests; this one is kept
/// local rather than shared because the relocation is verbatim, and the
/// shared copy's `#[derive(Clone)]` is not part of what these tests assumed.)
struct RecSink {
    tx: mpsc::UnboundedSender<(String, Value)>,
}

impl EventSink for RecSink {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.tx.send((event.to_string(), payload));
    }
}

/// A temp `Db` + a temp `cwd` dir (the `spaces` rows are keyed by
/// the CANONICAL path, so the cwd must exist), OWNED (#96 task 08).
///
/// THE GUARD IS FIRST and the tuple is WIDER than it was
/// (`(Arc<Db>, PathBuf)` → `(ScratchDir, Arc<Db>, PathBuf)`): destructured
/// locals drop in REVERSE declaration order, so `cwd` → `db` → `dir`. That
/// is the order Windows needs — `dir` holds `db.sqlite`, and Windows refuses
/// to remove a directory containing an open file — and it is the order
/// `harness/store.rs::temp_db` (task 03) and `tests/harness_store.rs::temp_db`
/// (task 06) already use. The `cwd` is `dir.join("workspace")`, a CHILD of
/// the guard, so `Drop` takes it with the tree; it stays a `PathBuf` because
/// the tests pass it to `db.upsert_space(&cwd.display().to_string(), …)` and
/// to the gate.
///
/// Linux cannot show a wrong order here (POSIX unlinks out from under an open
/// handle and `ScratchDir::Drop` swallows the failure), so this ordering is
/// enforced by reading, not by any gate on this box.
fn temp_db_cwd() -> (ScratchDir, Arc<Db>, std::path::PathBuf) {
    let dir = ScratchDir::in_env_temp("perm-gate-", "db");
    let db = Arc::new(Db::open(&dir.join("db.sqlite")).unwrap());
    let cwd = dir.join("workspace");
    std::fs::create_dir_all(&cwd).unwrap();
    (dir, db, cwd)
}

fn fresh_pending() -> PendingPermissions {
    Arc::new(tokio::sync::Mutex::new(HashMap::new()))
}

#[tokio::test]
async fn native_gate_trusted_space_auto_approves() {
    let (_dir, db, cwd) = temp_db_cwd();
    db.upsert_space(&cwd.display().to_string(), false).unwrap();
    db.set_space_trusted(&cwd.display().to_string(), true)
        .unwrap();
    let (sink_tx, mut sink_rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(RecSink { tx: sink_tx });
    let pending = fresh_pending();
    let cancel = CancellationToken::new();

    let outcome = native_permission_gate(
        "s1",
        "r1",
        "Allow bash?",
        &sink,
        &pending,
        Some(&SqliteTrustSource::new(db)),
        &cwd,
        &cancel,
        permission_options(true),
    )
    .await;

    assert_eq!(
        outcome,
        PermissionOutcome::Selected {
            option_id: "allow".into(),
            value: None,
        },
        "a trusted Space is auto-approved (ADR 0010)"
    );
    assert!(
        sink_rx.try_recv().is_err(),
        "a trusted Space emits no permission-request"
    );
    assert!(
        pending.lock().await.is_empty(),
        "a trusted Space registers no oneshot"
    );
}

#[tokio::test]
async fn native_gate_untrusted_prompts_and_maps_the_outcome() {
    let (_dir, db, cwd) = temp_db_cwd();
    db.upsert_space(&cwd.display().to_string(), false).unwrap();
    // Untrusted (the default) → the prompt flow.
    let (sink_tx, mut sink_rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(RecSink { tx: sink_tx });
    let pending = fresh_pending();
    let cancel = CancellationToken::new();
    // Clones for the spawned task (the test keeps `pending` to
    // resolve the oneshot + assert the map is drained after).
    let task_pending = pending.clone();
    let task_db = db.clone();
    let task_cwd = cwd.clone();
    let task_cancel = cancel.clone();
    let task = tokio::spawn(async move {
        native_permission_gate(
            "s1",
            "r1",
            "Allow bash?",
            &sink,
            &task_pending,
            Some(&SqliteTrustSource::new(task_db)),
            &task_cwd,
            &task_cancel,
            permission_options(true),
        )
        .await
    });

    // Wait for the `permission-request` event (the oneshot is
    // registered before it — the entry is already in the map).
    let (_event, payload) = loop {
        if let Ok(m) = sink_rx.try_recv() {
            if m.0 == "permission-request" {
                break m;
            }
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    assert_eq!(payload["requestId"], "r1");
    assert_eq!(payload["request"]["toolCall"]["title"], "Allow bash?");
    assert_eq!(payload["request"]["options"].as_array().unwrap().len(), 3);
    // The EMISSION path pins the boundary list: `trust-space` is the
    // third option of the payload the UI actually receives.
    assert_eq!(payload["request"]["options"][0]["optionId"], "allow");
    assert_eq!(payload["request"]["options"][1]["optionId"], "reject");
    assert_eq!(
        payload["request"]["options"][2]["optionId"], "trust-space",
        "the boundary prompt offers `trust-space`"
    );

    // Resolve with `allow` (the `respond_permission` path).
    let key = permission_key("s1", "r1");
    let sender = pending
        .lock()
        .await
        .remove(&key)
        .expect("the oneshot is registered");
    sender
        .send(PermissionOutcome::Selected {
            option_id: "allow".into(),
            value: None,
        })
        .unwrap();
    assert_eq!(
        task.await.unwrap(),
        PermissionOutcome::Selected {
            option_id: "allow".into(),
            value: None,
        }
    );
    // The entry is removed after the answer.
    assert!(pending.lock().await.is_empty());
}

#[tokio::test]
async fn native_gate_trust_space_allows_without_writing_the_flag() {
    let (_dir, db, cwd) = temp_db_cwd();
    db.upsert_space(&cwd.display().to_string(), false).unwrap();
    assert!(!db.space_trusted(&cwd).unwrap(), "untrusted by default");
    let (sink_tx, _sink_rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(RecSink { tx: sink_tx });
    let pending = fresh_pending();
    let cancel = CancellationToken::new();
    // Clones for the spawned task (the test keeps `pending` / `db`
    // / `cwd` to resolve the oneshot + assert the flag after).
    let task_pending = pending.clone();
    let task_db = db.clone();
    let task_cwd = cwd.clone();
    let task_cancel = cancel.clone();
    let task = tokio::spawn(async move {
        native_permission_gate(
            "s1",
            "r2",
            "Allow write?",
            &sink,
            &task_pending,
            Some(&SqliteTrustSource::new(task_db)),
            &task_cwd,
            &task_cancel,
            permission_options(true),
        )
        .await
    });
    // Wait for the prompt, then resolve with `trust-space`.
    loop {
        let map = pending.lock().await;
        if map.contains_key(&permission_key("s1", "r2")) {
            break;
        }
        drop(map);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let key = permission_key("s1", "r2");
    pending
        .lock()
        .await
        .remove(&key)
        .unwrap()
        .send(PermissionOutcome::Selected {
            option_id: "trust-space".into(),
            value: None,
        })
        .unwrap();
    assert_eq!(
        task.await.unwrap(),
        PermissionOutcome::Selected {
            option_id: "trust-space".into(),
            value: None,
        },
        "the outcome is the user's selection (the caller maps it to allow)"
    );
    // (ADR 0025) The flag write is NOT in the gate anymore (the
    // Worker has no `Db`): the Supervisor's `respond_permission`
    // relay applies it (Task 4) + the Worker's `StaticTrustSource`
    // is flipped (Task 2).
    assert!(
        !db.space_trusted(&cwd).unwrap(),
        "the gate no longer writes the trust flag (the Supervisor does — ADR 0025)"
    );
}

#[tokio::test]
async fn native_gate_cancel_is_a_denial() {
    let (_dir, db, cwd) = temp_db_cwd();
    let (sink_tx, _sink_rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(RecSink { tx: sink_tx });
    let pending = fresh_pending();
    let cancel = CancellationToken::new();
    cancel.cancel();

    let outcome = native_permission_gate(
        "s1",
        "r3",
        "Allow bash?",
        &sink,
        &pending,
        Some(&SqliteTrustSource::new(db)),
        &cwd,
        &cancel,
        permission_options(true),
    )
    .await;
    assert_eq!(
        outcome,
        PermissionOutcome::Cancelled,
        "a cancel is a denial (never an auto-allow)"
    );
}
