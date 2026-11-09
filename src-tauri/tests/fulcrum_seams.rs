//! T5/S4 — the SEAM INSTANTIATION pins (plan Steps B, B-bis, E.1–E.3; the status
//! file's **S4 RULING**, which is what this file exists to satisfy).
//!
//! ## Why these tests look strange, and why they must
//!
//! S4 gives `fulcrum-core` its FIRST outward references: two traits the crate does
//! not call yet, and wire types nothing inside it names yet. The S4 ruling states
//! the consequence in terms — *"a green suite proves almost nothing here"* and *"a
//! surface-comparison test that never instantiates the impl is void"*. So the gate
//! for this sub-step is not "the suite is green" but:
//!
//! 1. `impl FulcrumPersistence for storage::Db` **compiles** →
//!    [`db_satisfies_fulcrumpersistence`];
//! 2. `impl Dispatcher for worker::manager::WorkerManager` **compiles** →
//!    [`worker_manager_satisfies_dispatcher`];
//! 3. every moved type keeps the desktop's EXISTING paths compiling unchanged →
//!    [`moved_wire_types_keep_every_existing_desktop_path_resolving`] and
//!    [`moved_dtos_keep_every_existing_desktop_path_resolving`]. That is the E1/E3
//!    proof, and its strongest half is that the desktop's own `worker/**`,
//!    `session/`, `commands/`, `bin/fake_worker.rs` and the 23 integration tests
//!    were NOT edited — they are the pin.
//!
//! ## Non-vacuity — the deletion that reddens each pin
//!
//! A compile-time assertion is worth only its failure mode, so each pin names the
//! deletion that breaks it. The measurements for the desktop-side deletions are in
//! the S4 report; the two bullets marked CRATE-SIDE name deletions this checkout
//! cannot perform (T8 moved those files into the rev-pinned crate) and are marked
//! as proven in the crate's own CI instead of being silently dropped:
//!
//! - Delete `impl FulcrumPersistence for Db` (`storage/db.rs`) → `E0277: the trait
//!   bound Db: FulcrumPersistence is not satisfied` here, at every `Arc<dyn
//!   FulcrumPersistence>` coercion in this file, and at
//!   [`the_persistence_surface_round_trips_through_a_real_db`].
//! - Delete `impl Dispatcher for WorkerManager` — CRATE-SIDE since T8/S8.3
//!   (`fulcrum/src/worker/manager/mod.rs`, `impl crate::seams::Dispatcher for
//!   WorkerManager`). That impl and the type are both owned by the crate, so the
//!   `E0277` proof runs in `archimedes-codes/fulcrum`'s CI, NOT here: this
//!   checkout has no `worker/manager/mod.rs`. What stays provable HERE is the
//!   re-export seam: drop the `manager` token from
//!   `pub use fulcrum_harness::worker::{…}` in `agent/worker/mod.rs` →
//!   [`worker_manager_satisfies_dispatcher`] and the `Arc<dyn Dispatcher>`
//!   coercion fail to resolve the name (`unresolved import`).
//! - Delete the `pub use crate::worker_types::{…}` block in
//!   `fulcrum/src/worker/protocol.rs` — CRATE-SIDE since T8/S8.1, so its
//!   consumers fail in the crate's CI; there is no `agent/worker/protocol.rs` in
//!   this checkout to delete. What stays provable HERE is the desktop half: drop
//!   the `protocol` token from `pub use fulcrum_harness::worker::{…}` in
//!   `agent/worker/mod.rs` → [`moved_wire_types_keep_every_existing_desktop_path_resolving`]
//!   fails, because the desktop spells these types at
//!   `crate::agent::worker::protocol::…` through that module alias.
//! - Delete the `pub use fulcrum_harness::store_rows::{…}` in `storage/db.rs`, or the
//!   one in `src/types.rs` → the row/DTO pins fail at the `Db::session` /
//!   `Db::messages_for` / `record_session` sites, and the desktop's `commands/` +
//!   `tests/storage.rs` readers fail with them.
//!
//! ## What these pins CANNOT prove
//!
//! That the seams are RIGHT for their callers. No crate code calls either trait
//! until S5 moves `persist.rs` and `subagent.rs` — the ruling expects that, and
//! names the mitigation: check the surface against what S5 actually calls before
//! dispatching. That check is why `record_message` is on the trait although the
//! plan's 15-method draft omitted it (`persist.rs:149` calls it on the `Display`
//! arm, and a missing method there is an S5 surprise).

use std::sync::Arc;

use fulcrum_harness::seams::{Dispatcher, FulcrumPersistence, StoreError};

use archimedes_lib::agent::harness::catalog::{Model, ModelCatalog};
use archimedes_lib::agent::harness::store::DisplayRow;
// `TrustSource` comes in through the DESKTOP's re-export path (the one
// `harness/mod.rs` / `harness/loop.rs` / `worker/core.rs` import), so these
// pins exercise the re-export seam as well as the impl.
use archimedes_lib::agent::harness::trust::{SqliteTrustSource, TrustSource};
use archimedes_lib::agent::subagent::{
    AgentNameResolution, SubagentFailureReason, SubagentMetrics, SubagentOutcome,
};
use archimedes_lib::agent::worker::manager::{WorkerFactory, WorkerManager};
use archimedes_lib::agent::worker::protocol::{
    DesktopConfig, StartEnv, StartMode, StoreFrame, SubagentDispatchWire,
};
use archimedes_lib::agent::worker::{WorkerError, WorkerErrorKind, WorkerHandle};
use archimedes_lib::storage::{Db, DbError, MessageRow, SessionRow};
use archimedes_lib::types::{ContextUsage, SessionInfo};

// ── Pin 1 — `Db` satisfies `FulcrumPersistence` ───────────────────────────────

/// `storage::Db` IS a `FulcrumPersistence`.
///
/// The generic bound is the assertion. This is exactly what Step B-bis says a
/// surface-comparison test fails to do: comparing method names by hand still
/// passes when the impl block is deleted, whereas `assert_persistence::<Db>()`
/// cannot be monomorphised without the real impl — including the trait's
/// `Send + Sync` supertraits, so it also proves `Db` is shareable behind the
/// `Arc` that `TranscriptPersister` holds.
#[test]
fn db_satisfies_fulcrumpersistence() {
    fn assert_persistence<T: FulcrumPersistence>() {}
    assert_persistence::<Db>();

    // The shape S5 actually holds. A `dyn` coercion is an INDEPENDENT use of the
    // impl: it needs the impl to exist and the trait to stay object-safe.
    let (dir, db) = temp_db("fulcrum-seams-pin1-");
    let obj: Arc<dyn FulcrumPersistence> = db;
    assert!(
        obj.now_ms() > 1_577_836_800_000,
        "the trait's `now_ms` must return a real millisecond timestamp through the seam"
    );
    drop(dir);
}

/// The persistence round trip through `Arc<dyn FulcrumPersistence>` on a REAL db —
/// the trait is callable, not merely satisfiable.
///
/// Every method that returns a MOVED type is exercised here, because those are the
/// signatures where a half-finished move would show up as a type error the bound
/// alone would not catch (the bound checks the impl exists; it does not check that
/// the `SessionRow` the impl returns is the one the trait names — though in fact
/// the impl would not compile if it were not).
#[test]
fn the_persistence_surface_round_trips_through_a_real_db() {
    let (dir, db) = temp_db("fulcrum-seams-pin-roundtrip-");
    let obj: Arc<dyn FulcrumPersistence> = db;

    obj.record_session(&session_info("s1"))
        .expect("record_session over the moved SessionInfo");
    let row: Option<SessionRow> = obj.session("s1").expect("session()");
    let row: SessionRow = row.expect("the row just recorded");
    assert_eq!(row.id, "s1");
    assert!(!row.is_subagent, "the fixture records a main session");
    assert!(
        row.cost_usd.is_none(),
        "no cost frame yet — None, not 0.0 (ADR 0082)"
    );

    // The transcript (E1's own frames, applied through the trait).
    obj.insert_native_message("s1", 0, "system", r#"{"role":"system"}"#)
        .expect("insert_native_message");
    obj.insert_native_message("s1", 1, "user", r#"{"role":"user"}"#)
        .expect("insert_native_message");
    let transcript = obj
        .load_native_messages("s1")
        .expect("load_native_messages");
    assert_eq!(
        transcript.len(),
        2,
        "seq-ordered transcript, got {transcript:?}"
    );
    obj.replace_native_messages(
        "s1",
        &[(0, "system".to_string(), r#"{"compacted":true}"#.to_string())],
    )
    .expect("replace_native_messages (the compaction rewrite)");
    assert_eq!(
        obj.load_native_messages("s1").expect("reload").len(),
        1,
        "the rewrite REPLACED rather than appended"
    );

    // The display rows (the method the plan's draft omitted — persist.rs:149).
    obj.record_message("s1", "agent-text", Some("m1"), r#"{"text":"hi"}"#)
        .expect("record_message");
    let msgs: Vec<MessageRow> = obj.messages_for("s1").expect("messages_for");
    assert_eq!(msgs.len(), 1, "got {msgs:?}");
    assert_eq!(msgs[0].kind, "agent-text");
    assert_eq!(msgs[0].message_key.as_deref(), Some("m1"));

    // The scalar session columns.
    obj.record_session_context_usage("s1", 10, 100)
        .expect("record_session_context_usage");
    obj.record_session_cost("s1", 0.25)
        .expect("record_session_cost");
    assert_eq!(obj.session_cost("s1").expect("session_cost"), Some(0.25));
    obj.record_session_todos("s1", Some("[]"))
        .expect("record_session_todos");
    assert_eq!(
        obj.session_todos("s1").expect("session_todos").as_deref(),
        Some("[]")
    );
    assert_eq!(obj.list_sessions(false).expect("list_sessions").len(), 1);

    // The permission-fixture half of the surface.
    obj.upsert_space(dir.join("space").to_str().expect("utf-8 path"), true)
        .expect("upsert_space");
    let key = dir.join("space").to_str().expect("utf-8 path").to_string();
    let key = std::fs::canonicalize(&key)
        .map(|p| p.display().to_string())
        .unwrap_or(key);
    assert!(
        obj.set_space_trusted(&key, false)
            .expect("set_space_trusted"),
        "the row `upsert_space` wrote must be findable by the same canonical key"
    );

    // `None` for a session that never existed — and NOT an error.
    assert_eq!(
        obj.session_cost("nope")
            .expect("a missing row is not an error"),
        None
    );
    drop(dir);
}

/// `DbError → StoreError` maps `Sqlite → Io` and KEEPS the message (Step B-bis).
///
/// The collapse is a LOSS, so the honest guard is twofold: the variant really does
/// collapse (this test), and the sentence the user reads still names the layer
/// that failed (the `Display` assertion). Today the only crate-side consumer of a
/// persistence error is `TranscriptPersister`, which `eprintln!`s and continues —
/// so no behaviour rides on the variant, which is the measurement that licenses
/// the collapse in the first place.
#[test]
fn dberror_converts_to_storeerror_collapsing_sqlite_into_io() {
    let sqlite: StoreError = DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows).into();
    assert!(
        matches!(sqlite, StoreError::Io(_)),
        "`Sqlite` must collapse to `Io` — got {sqlite:?}"
    );
    assert_eq!(
        sqlite.to_string(),
        "io error: sqlite error: Query returned no rows",
        "the message must still name the layer that failed, or the collapse is a silent downgrade"
    );

    // The two variants that pass through unchanged.
    let io: StoreError = DbError::Io(std::io::Error::other("disk went away")).into();
    assert!(matches!(io, StoreError::Io(_)));
    assert_eq!(io.to_string(), "io error: disk went away");
    let json: StoreError = DbError::Json(serde_json::from_str::<u32>("nope").unwrap_err()).into();
    assert!(matches!(json, StoreError::Json(_)));
    assert!(json.to_string().starts_with("json error: "));
}

/// The ONE clock (Step B-bis's "no second clock source").
///
/// The desktop's two private `now_ms` bodies are deleted — `storage/db.rs`'s
/// private fn and `agent/normalize.rs`'s `pub(crate)` fn — and both files now name
/// `fulcrum_harness::clock::now_ms`. Through the seam, the value must be the same
/// clock, not merely the same shape: a per-implementation clock would agree today
/// and drift the moment a second store appeared.
#[test]
fn the_traits_clock_is_the_same_clock_the_rows_are_stamped_with() {
    let (dir, db) = temp_db("fulcrum-seams-pin-clock-");
    let obj: Arc<dyn FulcrumPersistence> = db;
    let via_trait = obj.now_ms();
    let shared = fulcrum_harness::clock::now_ms();
    assert!(
        (shared - via_trait).abs() <= 5,
        "seam said {via_trait}, the shared clock says {shared}: two clocks would drift, not merely differ"
    );
    // And the store's OWN writes use that clock: `created_at` on a row written
    // through the trait is a real timestamp, not a zero or a seconds-based value.
    obj.record_session(&session_info("s1"))
        .expect("record_session");
    let row = obj.session("s1").expect("session").expect("the row");
    assert!(
        (row.created_at - via_trait).abs() <= 5_000,
        "the row's created_at {} is not on the same clock as now_ms {via_trait}",
        row.created_at
    );
    drop(dir);
}

// ── Pin 2 — `WorkerManager` satisfies `Dispatcher` ────────────────────────────

/// `worker::manager::WorkerManager` IS a `Dispatcher`.
///
/// Same shape as pin 1. It cannot pass without the impl block, and it cannot pass
/// if the trait's `SubagentDispatchWire` / `SubagentOutcome` parameter types drift
/// from the ones the desktop's inherent `dispatch_subagent_to` accepts — the
/// specific failure this sub-step could otherwise hide, since BOTH types moved
/// into the crate in S4.
#[test]
fn worker_manager_satisfies_dispatcher() {
    fn assert_dispatcher<T: Dispatcher>() {}
    assert_dispatcher::<WorkerManager>();

    // The shape S5 holds: `SubagentSessionManager` keeps an `Arc<dyn Dispatcher>`
    // (today it keeps `Arc<WorkerManager>` — edge E2). The coercion is the second
    // use of the impl and additionally proves `Send + Sync`, which the manager is
    // only because its state is `Arc`-backed.
    let manager = stub_worker_manager();
    let dyn_dispatcher: Arc<dyn Dispatcher> = manager;
    // Object safety observed, not assumed: callable through the erased type. A
    // cancel for an id never dispatched is a NO-OP by contract (the manager's
    // `cancel_subagent` is a no-op for a gone drive), so calling it is safe.
    dyn_dispatcher.cancel_subagent("arch_never_dispatched");
}

/// The `Dispatcher` trait's parameter types ARE the desktop's — one type, not two
/// compatible-looking ones.
///
/// This is the concrete meaning of "the moved types are the same types", and it is
/// what makes S5's `Arc<dyn Dispatcher>` swap mechanical rather than a
/// re-derivation: if the desktop had kept its own `SubagentDispatchWire`, the call
/// below would not type-check.
#[test]
fn the_dispatcher_trait_names_the_same_types_the_desktop_passes() {
    fn dispatch_through_the_seam(
        d: &dyn Dispatcher,
        wire: SubagentDispatchWire,
        tx: tokio::sync::oneshot::Sender<SubagentOutcome>,
    ) {
        d.dispatch_subagent_to("parent-1", wire, "child-1".to_string(), tx);
    }
    // Never invoked — the signature's type-check is the assertion. Invoking it
    // would spawn a Worker for no additional evidence; the dispatch flow itself is
    // covered by `worker_e2e.rs` and the manager's own tests.
    let _ = dispatch_through_the_seam;

    // The desktop's inherent method accepts the SAME wire type the trait declares:
    // an assignment between the two function pointers only compiles if the
    // parameter types are identical.
    let inherent: fn(
        &WorkerManager,
        &str,
        SubagentDispatchWire,
        String,
        tokio::sync::oneshot::Sender<SubagentOutcome>,
    ) = WorkerManager::dispatch_subagent_to;
    let _ = inherent;
}

// ── Pin 3 — the E1/E3 proof: moved wire types at their OLD desktop paths ──────

/// Every moved wire type is reachable at the desktop path its consumers already
/// use, and is usable in the shape the moved code uses it.
///
/// Per the S4 ruling, the unchanged-compiling desktop IS the E1/E3 proof; what this
/// adds is the part an import list does not show — that the re-export carries the
/// real definitions. The serde assertions are the load-bearing half: a wire-type
/// move is behaviour-identical only if the BYTES are identical, and these catch a
/// field renamed or re-cased in transit.
#[test]
fn moved_wire_types_keep_every_existing_desktop_path_resolving() {
    // `StartMode`: the `Copy` enum whose `FreshChild` arm keeps a child out of the
    // main-prompt arm (issue #9).
    let mode = StartMode::FreshChild;
    assert_eq!(mode, StartMode::FreshChild);
    assert_eq!(
        serde_json::to_string(&mode).expect("encodable"),
        "\"fresh_child\"",
        "snake_case is the wire contract"
    );

    // `StoreFrame`: what `persist.rs:97` consumes, built as `IpcStore` emits it
    // and matched as `apply` matches it.
    let frame = StoreFrame::Insert {
        session_id: "s1".to_string(),
        seq: 7,
        role: "user".to_string(),
        content_json: "{}".to_string(),
    };
    let sid = match &frame {
        StoreFrame::Insert { session_id, .. }
        | StoreFrame::Replace { session_id, .. }
        | StoreFrame::Display { session_id, .. }
        | StoreFrame::ContextUsage { session_id, .. } => session_id,
    };
    assert_eq!(
        sid, "s1",
        "every arm carries the CHILD's session id (the FK target)"
    );

    // `DisplayRow` INSIDE `StoreFrame::Display` — the pair that had to move
    // together, so this one construction proves both sides see one type.
    let display = StoreFrame::Display {
        session_id: "s1".to_string(),
        rows: vec![DisplayRow {
            kind: "agent-text".to_string(),
            message_key: "m1".to_string(),
            payload_json: serde_json::json!({"text": "hi"}),
            created_at: 1,
        }],
    };
    match display {
        StoreFrame::Display { rows, .. } => assert_eq!(rows.len(), 1),
        other => panic!("the Display arm must still be constructible, got {other:?}"),
    }

    // `DesktopConfig::from_env` — the child-inherits-the-parent's-five hop at
    // `subagent_flow.rs:752`. It reads five fields off a `StartEnv`, so the two
    // types must be the pair the envelope actually carries.
    let env = minimal_start_env();
    let cfg = DesktopConfig::from_env(&env);
    assert!(
        cfg.providers.is_empty(),
        "the fixture packages no providers"
    );
    assert!(cfg.mcp_servers.is_empty());

    // `SubagentDispatchWire`: E3's type, built as `subagent.rs:188` builds it.
    let wire = SubagentDispatchWire {
        id: "w1".to_string(),
        parent_session_id: "parent-1".to_string(),
        parent_cwd: "/tmp".to_string(),
        parent_enabled_tools: vec!["read".to_string()],
        agent_name: "scout".to_string(),
        name_resolution: AgentNameResolution::Matched,
        launch: fulcrum_harness::launch_config::LaunchConfig::default(),
        task: "do the thing".to_string(),
        model_key: "tama/m-1".to_string(),
    };
    let json = serde_json::to_string(&wire).expect("the wire type is always encodable");
    assert!(
        json.contains("\"parentSessionId\":\"parent-1\""),
        "payload field names stay camelCase, got {json}"
    );
    assert!(
        json.contains("\"nameResolution\":\"matched\""),
        "the resolution enum stays snake_case on the wire, got {json}"
    );
    assert!(
        !json.contains("\"name_resolution\""),
        "no snake_case leakage into payload field names, got {json}"
    );
    let back: SubagentDispatchWire = serde_json::from_str(&json).expect("round trip");
    assert_eq!(back, wire);

    // `nameResolution` has NO serde default — every default would be a lie about
    // whether a persona loaded, so a missing field is a hard decode error. That
    // contract moved with the type and must not have softened.
    let missing = r#"{"id":"w1","parentSessionId":"p","parentCwd":"/tmp","parentEnabledTools":[],"agentName":"a","launch":{},"task":"t","modelKey":"tama/m-1"}"#;
    assert!(
        serde_json::from_str::<SubagentDispatchWire>(missing).is_err(),
        "a `subagent-dispatch` line WITHOUT nameResolution must stay a decode error"
    );
}

// ── Pin 4 — the moved DTOs keep their desktop spellings ───────────────────────

/// `SessionRow`/`MessageRow` at `crate::storage::…`, `SessionInfo`/`ContextUsage`
/// at `crate::types::…`, `DisplayRow` at `crate::agent::harness::store::…` — all
/// still resolve, and all denote the CRATE's type.
///
/// The assignments are the assertion: a desktop twin struct would fail to compile
/// at the assignment, not at the call. The ~117 `SessionInfo` sites and the
/// `commands/` + `tests/storage.rs` row readers were never touched.
#[test]
fn moved_dtos_keep_every_existing_desktop_path_resolving() {
    fn info_from_types(v: SessionInfo) -> fulcrum_harness::store_rows::SessionInfo {
        v
    }
    fn info_from_agent(v: archimedes_lib::agent::SessionInfo) -> SessionInfo {
        v
    }
    fn usage(v: ContextUsage) -> fulcrum_harness::store_rows::ContextUsage {
        v
    }
    fn row(v: SessionRow) -> fulcrum_harness::store_rows::SessionRow {
        v
    }
    fn msg(v: MessageRow) -> fulcrum_harness::store_rows::MessageRow {
        v
    }
    fn display(v: DisplayRow) -> fulcrum_harness::store_rows::DisplayRow {
        v
    }
    let _ = (info_from_types, info_from_agent, usage, row, msg, display);

    // `SessionInfo`'s camelCase IPC contract survived the move (it is what the
    // frontend reads, and `session.cwd === space.path` compares it as a string).
    let json =
        serde_json::to_string(&session_info("s1")).expect("SessionInfo is the IPC return type");
    assert!(
        json.contains("\"sessionId\":\"s1\"") && json.contains("\"cwd\":\"/tmp\""),
        "camelCase + a stringified cwd are the frontend contract, got {json}"
    );
    assert!(
        !json.contains("\"costUsd\"") || json.contains("\"costUsd\":null"),
        "costUsd stays present-and-null, never a collapsed 0.0, got {json}"
    );
    // `ContextUsage` round-trips through the JSON blob the `sessions` column holds.
    let usage = ContextUsage {
        used: 1234,
        window: 200_000,
    };
    let blob = serde_json::to_string(&usage).expect("encodable");
    assert_eq!(
        blob, r#"{"used":1234,"window":200000}"#,
        "the `sessions.context_usage_json` column holds exactly this shape"
    );
    // Compared field by field, not with `assert_eq!`: `ContextUsage` never derived
    // `PartialEq` on the desktop either, and adding a derive to a moved DTO would
    // widen its surface for a test's convenience.
    let back: ContextUsage = serde_json::from_str(&blob).expect("round trip");
    assert_eq!((back.used, back.window), (1234, 200_000));
}

/// The subagent outcome vocabulary is ONE type across the boundary (E2's oneshot
/// payload and E3's wire field both name it).
#[test]
fn the_subagent_vocabulary_is_one_type_across_the_boundary() {
    fn outcome(v: SubagentOutcome) -> fulcrum_harness::subagent_types::SubagentOutcome {
        v
    }
    fn metrics(v: SubagentMetrics) -> fulcrum_harness::subagent_types::SubagentMetrics {
        v
    }
    fn reason(v: SubagentFailureReason) -> fulcrum_harness::subagent_types::SubagentFailureReason {
        v
    }
    let _ = (outcome, metrics, reason);

    // The `None` vs `Some(0.0)` distinction (issue #107 / ADR 0082) is a SERDE
    // fact and the reason this DTO was safe to move at all.
    let unpriced = SubagentOutcome::Completed {
        output: String::new(),
        metrics: SubagentMetrics {
            output: String::new(),
            input_tokens: 0,
            output_tokens: 0,
            cost: None,
            duration_ms: 0,
        },
    };
    let json = serde_json::to_string(&unpriced).expect("encodable");
    assert!(
        json.contains("\"cost\":null"),
        "`None` crosses as present-and-null, never absent — got {json}"
    );
    let priced = SubagentOutcome::Completed {
        output: String::new(),
        metrics: SubagentMetrics {
            cost: Some(0.0),
            ..Default::default()
        },
    };
    let priced_json = serde_json::to_string(&priced).expect("encodable");
    assert!(
        priced_json.contains("\"cost\":0.0"),
        "a genuine zero is a FIGURE and must not read as null — got {priced_json}"
    );
    // `SubagentFailureReason` stays snake_case with a `#[default]` of `Other`.
    assert_eq!(
        serde_json::to_string(&SubagentFailureReason::Unresponsive).expect("encodable"),
        "\"unresponsive\""
    );
    assert_eq!(
        SubagentFailureReason::default(),
        SubagentFailureReason::Other
    );
}

/// The §2c config DTOs are ONE type across the boundary (`StartEnv`'s fields and
/// the desktop's `Settings` agree), which is what the first build after the crate
/// gained `config_types` proved the hard way — six
/// `expected ProviderConfig, found config::ProviderConfig` errors at
/// `session/mod.rs:1527`, `worker/core.rs:288/355/356`, `worker/manager/mod.rs:445`
/// (paths AS THEY WERE THEN — `worker/**` is crate-owned since T8, so only
/// `session/mod.rs` still exists on the desktop disk).
///
/// # Non-vacuity — the mutation that reddens each half of this pin
///
/// Two independent mechanisms, because they catch different breakages:
///
///   * **The identity fns** prove the TYPE. Each takes the `archimedes_lib::`
///     spelling and returns the `fulcrum_harness::` spelling of the same value. If
///     the two spellings ever denote two DIFFERENT structs (a desktop twin, or a
///     re-export quietly replaced by a local mirror), the `return` is `E0308` —
///     the pin does not compile, so it cannot pass on a broken tree. A source-text
///     `contains` on this file could be satisfied by some OTHER function holding
///     an identically-typed parameter, which is exactly why this half is a
///     compile-time identity fn and not a grep.
///   * **The serde assertions** prove the BYTES. An identity fn cannot notice a
///     field rename or a re-case on one side (both spellings are still one type,
///     so it keeps compiling), so each DTO also round-trips JSON and asserts the
///     wire key spelling and the missing-field defaults. Drop
///     `rename_all = "camelCase"` from the crate's `FontSettings`, or change
///     `default_font_size()` from 14, and the assertion below fails on the JSON.
#[test]
fn the_config_dtos_are_one_type_across_the_boundary() {
    fn providers_move_across(
        p: archimedes_lib::config::ProviderConfig,
    ) -> Vec<fulcrum_harness::config_types::ProviderConfig> {
        vec![p]
    }
    fn overrides_move_across(
        o: archimedes_lib::config::AgentOverrideFields,
    ) -> fulcrum_harness::config_types::AgentOverrideFields {
        o
    }
    fn settings_move_across(
        s: archimedes_lib::config::Settings,
    ) -> fulcrum_harness::config_types::Settings {
        s
    }
    fn fonts_move_across(
        f: archimedes_lib::config::FontSettings,
    ) -> fulcrum_harness::config_types::FontSettings {
        f
    }
    fn oidc_move_across(
        c: archimedes_lib::config::OidcConfig,
    ) -> fulcrum_harness::config_types::OidcConfig {
        c
    }
    // `WebSettings` is NOT in the `config_types` block — S2 moved it to
    // `fulcrum_harness::web::config` and `config.rs` re-exports it from there, so the
    // desktop spelling is the `agent::web::config` module-alias path.
    fn web_settings_move_across(
        w: archimedes_lib::agent::web::config::WebSettings,
    ) -> fulcrum_harness::web::config::WebSettings {
        w
    }
    // Each identity fn above is CALLED in the assertions below (not merely
    // mentioned), which is what keeps the type pin from being deletable dead code.
    // A pre-feature `settings.json` row still parses to the same defaults — the
    // serde default FUNCTIONS moved with the struct, and `load_settings`'s
    // corrupt-file fallback depends on that not changing.
    let bare: archimedes_lib::config::ProviderConfig = serde_json::from_str(
        r#"{"id":"a","name":"A","baseUrl":"http://127.0.0.1:4000/v1","apiKey":""}"#,
    )
    .expect("a pre-feature provider row parses untouched");
    assert_eq!(bare.api, "openai-completions");
    assert_eq!(bare.auth_mode, "api_key");
    assert_eq!(bare.oidc, None);
    assert_eq!(providers_move_across(bare).len(), 1);

    // ADR 0067: an absent field is the ONLY spelling of "this layer does not
    // speak", and an empty override serialises to `{}` rather than a wall of nulls.
    let quiet: archimedes_lib::config::AgentOverrideFields =
        serde_json::from_str("{}").expect("an empty override says nothing");
    assert_eq!(quiet.model, None);
    assert_eq!(
        serde_json::to_string(&overrides_move_across(quiet)).expect("encodable"),
        "{}",
        "`skip_serializing_if` is ADR 0067's absence rule, not cosmetics"
    );

    // ── `Settings` — the whole app-settings document ──────────────────────────
    // Serialize the DESKTOP spelling, read the crate's bytes: the camelCase keys
    // and the `true`-by-default bools are the wire contract the renderer's
    // `AppSettings` declares required.
    let settings_json = serde_json::to_string(&settings_move_across(
        archimedes_lib::config::Settings::default(),
    ))
    .expect("the settings document is always encodable");
    assert!(
        settings_json.contains("\"theme\":\"dark\""),
        "`theme` keeps its spelling and `default_theme()`'s value — got {settings_json}"
    );
    assert!(
        settings_json.contains("\"sessionNamingEnabled\":true"),
        "`sessionNamingEnabled` is `default_true`, not `false` — got {settings_json}"
    );
    assert!(
        settings_json.contains("\"attentionAlertsEnabled\":true"),
        "`attentionAlertsEnabled` is `default_true` — got {settings_json}"
    );
    assert!(
        settings_json.contains("\"attentionAlertDelaySecs\":15"),
        "the attention delay is 15 SECONDS on the wire (`delaySecs`, not millis) — got {settings_json}"
    );
    assert!(
        settings_json.contains("\"sessionNamingModel\":null"),
        "`session_naming_model` carries NO `skip_serializing_if`, so absence is an explicit null — got {settings_json}"
    );
    // And the reverse direction: a pre-feature sparse file parses to the same
    // defaults through the CRATE spelling.
    let sparse: fulcrum_harness::config_types::Settings =
        serde_json::from_str("{}").expect("a pre-feature settings file parses to the defaults");
    assert_eq!(sparse.theme, "dark");
    assert!(sparse.session_naming_enabled);
    assert_eq!(sparse.session_naming_model, None);
    assert_eq!(sparse.font.size_px, 14);
    assert_eq!(sparse.attention_alert_delay_secs, 15);

    // ── `FontSettings` — 3 fields, and TWO different defaults for one field ───
    // The hand-written `Default` ships the app's font families; serde's
    // missing-field default leaves them `None` (the frontend's own CSS stack
    // applies then). So parsing `{}` is NOT `FontSettings::default()`, and this is
    // where that asymmetry is recorded.
    let bare_font: fulcrum_harness::config_types::FontSettings =
        serde_json::from_str("{}").expect("an absent font block is legal");
    assert_eq!(
        bare_font.size_px, 14,
        "`default_font_size()` travels with the struct"
    );
    assert!(
        bare_font.ui_family.is_none(),
        "serde absence is `None`, not the app's stack"
    );
    assert!(bare_font.code_family.is_none());
    assert_ne!(
        bare_font,
        archimedes_lib::config::FontSettings::default(),
        "the hand-written `Default` names the shipped families; serde absence does not"
    );
    let font_json =
        serde_json::to_string(&fonts_move_across(archimedes_lib::config::FontSettings {
            size_px: 16,
            ui_family: Some("Inter".to_string()),
            code_family: None,
        }))
        .expect("encodable");
    assert!(
        font_json.contains("\"sizePx\":16") && font_json.contains("\"uiFamily\":\"Inter\""),
        "`FontSettings` serializes camelCase — got {font_json}"
    );

    // ── `OidcConfig` — 4 fields, two of them REQUIRED ─────────────────────────
    let oidc_json = serde_json::to_string(&oidc_move_across(archimedes_lib::config::OidcConfig {
        issuer: "https://idp.example".to_string(),
        client_id: "archimedes".to_string(),
        scope: None,
        redirect_ports: Vec::new(),
    }))
    .expect("encodable");
    assert!(
        oidc_json.contains("\"clientId\":\"archimedes\""),
        "`client_id` crosses as `clientId` — got {oidc_json}"
    );
    let parsed_oidc: fulcrum_harness::config_types::OidcConfig = serde_json::from_str(
        r#"{"issuer":"https://idp.example","clientId":"archimedes"}"#,
    )
    .expect("scope/redirect_ports are `#[serde(default)]` — a bare issuer+client block is valid");
    assert_eq!(parsed_oidc.scope, None);
    assert!(
        parsed_oidc.redirect_ports.is_empty(),
        "an empty port list means one ephemeral port"
    );
    assert!(
        serde_json::from_str::<fulcrum_harness::config_types::OidcConfig>(
            r#"{"issuer":"https://x"}"#
        )
        .is_err(),
        "`client_id` is REQUIRED: an `oidc` block that omits it fails the whole document"
    );

    // ── `WebSettings` — 6 `String` fields, all-default-empty ──────────────────
    let bare_web: fulcrum_harness::web::config::WebSettings =
        serde_json::from_str("{}").expect("an absent web block is legal");
    assert_eq!(
        bare_web,
        archimedes_lib::agent::web::config::WebSettings::default(),
        "an absent `web` block is exactly `WebSettings::default()` (all empty ⇒ only the keyless Search provider is live)"
    );
    let web_json = serde_json::to_string(&web_settings_move_across(
        archimedes_lib::agent::web::config::WebSettings {
            brave_api_key: "k".to_string(),
            ..Default::default()
        },
    ))
    .expect("encodable");
    assert!(
        web_json.contains("\"braveApiKey\":\"k\""),
        "`brave_api_key` crosses as `braveApiKey` — got {web_json}"
    );

    // And the packaged envelope carries the SAME types (`StartEnv.providers` is a
    // `Vec<ProviderConfig>` — the field that forced this move).
    let env = minimal_start_env();
    let packaged: Vec<archimedes_lib::config::ProviderConfig> = env.providers.clone();
    assert!(packaged.is_empty());
}

/// E4: `resolve_composed_model` is the crate's function, and the DESKTOP's own
/// call sites still resolve through the re-export.
///
/// The desktop path (`crate::agent::session::…`, which `subagent_flow.rs:14`
/// imports) is inside a private `mod`, so an integration test cannot name it —
/// the proof for that half is that `session/mod.rs` compiles UNEDITED, which the
/// lib build establishes (`subagent_flow.rs` is crate-owned since T8/S8.3 —
/// `fulcrum/src/worker/manager/subagent_flow.rs` — so its half of that proof
/// runs in the crate's CI). What is checkable from here is the behaviour that
/// moved: the first-`/` rule, the unknown-key `None`, and the fact that a
/// `:<level>` suffix is the CALLER's problem (which `harness/launch.rs:173` —
/// crate-owned since T8 — depends on for its soft rung).
#[test]
fn resolve_composed_model_keeps_its_lookup_rules_after_the_move() {
    let deep = Model {
        id: "Qwen/Qwen3.8-27B".to_string(),
        provider: "tama".to_string(),
        ..test_model_shape()
    };
    let catalog = ModelCatalog {
        models: vec![deep],
        ..Default::default()
    };

    let found = fulcrum_harness::catalog::resolve_composed_model(&catalog, "tama/Qwen/Qwen3.8-27B")
        .expect("the composed key resolves");
    assert_eq!(
        found.id, "Qwen/Qwen3.8-27B",
        "the split is on the FIRST slash"
    );

    // No `/` is not a composed key; a well-formed key naming nothing is `None`;
    // the provider is part of the identity, not a hint.
    assert!(
        fulcrum_harness::catalog::resolve_composed_model(&catalog, "Qwen/Qwen3.8-27B").is_none()
    );
    assert!(fulcrum_harness::catalog::resolve_composed_model(&catalog, "tama/other").is_none());
    assert!(
        fulcrum_harness::catalog::resolve_composed_model(&catalog, "other/Qwen/Qwen3.8-27B")
            .is_none()
    );
    // The `:<level>` suffix is NOT stripped here — `launch.rs` does that via
    // `ModelRef::parse` BEFORE calling, and a half-match would turn a soft skip
    // into a wrong model.
    assert!(fulcrum_harness::catalog::resolve_composed_model(
        &catalog,
        "tama/Qwen/Qwen3.8-27B:high"
    )
    .is_none());
}

// ── Pin 5 (T5/S5a) — `SqliteTrustSource` satisfies the CRATE's `TrustSource` ──

/// The trust split's instantiation pin (the S5 RULING's SEAM 1, enforced with
/// the S4 RULING's rule: *"an impl nobody instantiates proves nothing"*).
///
/// `harness/trust.rs` SPLIT in S5a: the `TrustSource` trait and the pure
/// `StaticTrustSource` moved to `fulcrum_harness::trust`, and `SqliteTrustSource`
/// stayed desktop because it holds a `storage::Db` the crate must never name
/// (`rusqlite` is not in the crate's graph — Step B-bis — and reaching
/// `crate::storage` would be the `fulcrum-harness → archimedes_lib` edge that IS
/// the package cycle T5 severs). So the desktop now holds an IMPLEMENTATION of
/// a CRATE trait, exactly as `web/render.rs` holds the crate's
/// `RenderRequester` impl and `open.rs` holds the crate's `OpenRequester` impl.
///
/// A green suite does not prove that impl exists: after the split the crate
/// compiles with or without it, and the only things that DO lean on it are two
/// `policy_gate.rs` fixtures coercing a `SqliteTrustSource` into
/// `Arc<dyn TrustSource>` — test code, not a production call site. Hence the
/// generic bound below, which cannot be monomorphised without the real impl,
/// plus the `dyn` coercion, which additionally needs the trait to stay
/// object-safe and its `Send + Sync` supertraits to hold for `Arc<Db>`.
///
/// **Non-vacuity (measured):** delete the `impl TrustSource for SqliteTrustSource`
/// block in `src-tauri/src/agent/harness/trust.rs` and this fails with
/// `E0277: the trait bound SqliteTrustSource: TrustSource is not satisfied` — at
/// the bound, at the `dyn` coercion, and at
/// [`sqlite_trust_source_reads_the_space_flag`]'s `Some(&SqliteTrustSource::new(db))`
/// argument, where the same deletion breaks the relocated behaviour test too.
/// Deleting the `pub use fulcrum_harness::trust::{StaticTrustSource, TrustSource};`
/// re-export instead reddens `harness/mod.rs`'s re-export line and
/// `worker/core.rs`'s import — the re-export seam is the other half of the proof.
#[test]
fn sqlite_trust_source_satisfies_the_crate_trait() {
    fn assert_trust_source<T: TrustSource>() {}
    assert_trust_source::<SqliteTrustSource>();

    // The desktop's OWN spelling of the trait (through `harness/trust.rs`'s
    // re-export, which is what `harness/mod.rs`, `harness/loop.rs` and
    // `worker/core.rs` import) IS the crate's trait: the identity function
    // below only compiles if the two `dyn` types are the same type. A
    // re-declared desktop trait would fail here, not at the call.
    fn desktop_spelling_is_the_crate_trait(
        v: &dyn archimedes_lib::agent::harness::trust::TrustSource,
    ) -> &dyn fulcrum_harness::trust::TrustSource {
        v
    }

    // `SqliteTrustSource` behind the shape the loop actually holds.
    let (dir, db) = temp_db("fulcrum-seams-trust-");
    let obj: Arc<dyn fulcrum_harness::trust::TrustSource> = Arc::new(SqliteTrustSource::new(db));
    // Fail-closed through the seam: a path with no `spaces` row — and a path
    // that cannot canonicalize — is untrusted when the call goes through the
    // trait object, not merely when it goes through the concrete type.
    assert!(
        !desktop_spelling_is_the_crate_trait(obj.as_ref())
            .is_trusted(std::path::Path::new("/definitely/missing/path")),
        "the trait object fails closed"
    );
    drop(dir);
}

/// The `Db`-backed trust test that used to live in `harness/trust.rs`,
/// relocated VERBATIM (S5 RULING: `trust.rs`'s `Db` tests CANNOT travel —
/// `#[cfg(test)]` does not survive into an rlib and the crate cannot reach
/// `storage::Db`). It lives here rather than in `permission_gate_db.rs`
/// because it is the trust SPLIT's own proof: it is what makes
/// [`sqlite_trust_source_satisfies_the_crate_trait`] an instantiated impl
/// rather than a signature comparison.
#[test]
fn sqlite_trust_source_reads_the_space_flag() {
    // The guard is FIRST and `cwd` is a plain `PathBuf` INTO it — the ordering
    // the relocated permission fixture documents (Windows refuses to remove a
    // dir holding an open file; POSIX cannot show a wrong order).
    let dir = archimedes_lib::test_support::ScratchDir::in_env_temp("harness-trust-test-", "db");
    let db = Arc::new(Db::open(&dir.join("t.db")).expect("db should open"));
    let cwd = dir.join("workspace");
    std::fs::create_dir_all(&cwd).unwrap();

    let source = SqliteTrustSource::new(db.clone());
    // No `spaces` row yet → fail-closed `false`.
    assert!(!source.is_trusted(&cwd));
    db.upsert_space(&cwd.display().to_string(), false).unwrap();
    assert!(!source.is_trusted(&cwd), "an untrusted row is `false`");
    db.set_space_trusted(&cwd.display().to_string(), true)
        .unwrap();
    assert!(source.is_trusted(&cwd), "a trusted row is `true`");
    // A nonexistent path canonicalize-fails → `false` (fail-closed).
    assert!(!source.is_trusted(std::path::Path::new("/definitely/missing/path")));
}

/// The `StaticTrustSource` half moved to the crate, and the desktop's spelling
/// still denotes it — so `worker/core.rs`'s `Arc<StaticTrustSource>` (the
/// `config { trusted }` update + the `trust-space` flip) is unchanged.
#[test]
fn static_trust_source_is_the_crate_type_at_the_desktop_spelling() {
    let desktop = archimedes_lib::agent::harness::trust::StaticTrustSource::new(false);
    let crate_side: fulcrum_harness::trust::StaticTrustSource = desktop;
    crate_side.set(true);
    let via_desktop: Arc<dyn fulcrum_harness::trust::TrustSource> = Arc::new(crate_side);
    assert!(
        via_desktop.is_trusted(std::path::Path::new("/x")),
        "the flip is visible through the crate trait"
    );
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

/// A temp `Db` (the `harness_store.rs` pattern: the scratch dir is returned and
/// dropped LAST by the caller, so the SQLite file outlives the connection — the
/// ordering Windows needs and Linux cannot show).
fn temp_db(prefix: &str) -> (archimedes_lib::test_support::ScratchDir, Arc<Db>) {
    let dir = archimedes_lib::test_support::ScratchDir::in_env_temp(prefix, "db");
    let path = dir.join("db.sqlite");
    let db = Arc::new(Db::open(&path).expect("a temp db opens"));
    (dir, db)
}

fn session_info(id: &str) -> SessionInfo {
    SessionInfo {
        session_id: id.to_string(),
        cwd: std::path::PathBuf::from("/tmp"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        is_subagent: false,
        cost_usd: None,
    }
}

/// A `WorkerManager` that never spawns anything.
///
/// The stub factory is deliberate: pin 2 asserts a TRAIT BOUND, and constructing
/// the manager is only the vehicle. Spawning a real `fake_worker` would put a child
/// process on the pin's critical path for no extra evidence — the dispatch flow is
/// covered by `worker_e2e.rs` and the manager's own tests.
fn stub_worker_manager() -> Arc<WorkerManager> {
    struct NeverSpawns;
    impl WorkerFactory for NeverSpawns {
        fn spawn(&self) -> Result<WorkerHandle, WorkerError> {
            Err(WorkerError {
                kind: WorkerErrorKind::SpawnFailed,
            })
        }
    }
    Arc::new(WorkerManager::new(
        Arc::new(NeverSpawns),
        Arc::new(|_id: String, _code: Option<i32>, _pid: Option<u32>| {}),
        Arc::new(|_id: String, _is_subagent: bool, _evt| {}),
        Arc::new(|_id: &str| None),
    ))
}

/// A minimal `StartEnv`, built through the SAME positional constructor the
/// desktop's fixtures use, so the moved builder methods are exercised from their
/// real entry point.
fn minimal_start_env() -> StartEnv {
    StartEnv::from_parts(
        "s1".to_string(),
        "/tmp/space".to_string(),
        StartMode::Fresh,
        None,
        test_model_shape(),
        ModelCatalog::default(),
        None,
        true,
        None,
        "/tmp/config".to_string(),
        false,
        None,
        None,
    )
}

/// The `Model` fixture with its scalar fields defaulted, so the pins above read as
/// tests about the seam rather than about the struct's field list.
fn test_model_shape() -> Model {
    Model {
        id: "m-1".to_string(),
        provider: "tama".to_string(),
        base_url: "https://example/v1".to_string(),
        api_key: String::new(),
        context_window: 8192,
        cost_per_mtok_in: 0.0,
        cost_per_mtok_out: 0.0,
        supports_tools: true,
        supports_thinking: false,
        thinking_levels: Vec::new(),
        api: Some("openai-completions".to_string()),
    }
}

// ── Pin 6 (T5/S5b) — the two `Store` IMPLs the S5b split left on the desktop ──

/// `impl Store for SessionStore` and `impl Store for IpcStore` both COMPILE and
/// are INSTANTIATED (the S5b half of the S4 instantiation rule: an impl nobody
/// instantiates proves nothing — a hand-written surface comparison still passes
/// after the `impl` block is deleted, a generic bound does not).
///
/// # Why S5b needs this pin at all
///
/// S5b moved `pub trait Store` into the crate and re-typed all six methods from
/// `Result<_, DbError>` to `Result<_, StoreError>` (Ruling 2 — the addendum's
/// "both pure" was wrong, `DbError` wraps the SQLite driver's error and could not
/// cross). Both desktop impls were RE-PLUMBED to map at the boundary. A re-plumbed
/// impl that no test instantiates is exactly the S4 failure mode, so: the generic
/// bound, a `dyn` coercion, and one real call through each object.
///
/// # The deletion that reddens it
///
///   * delete `impl Store for SessionStore` (`agent/harness/store.rs` — EXISTS
///     here) → `E0277: SessionStore: Store is not satisfied` at the bound, at the
///     `Arc<dyn Store>` coercion, and at the identity fn below (measured; see the
///     S5b report for counts);
///   * delete `impl Store for IpcStore` — CRATE-SIDE since T8/S8.3
///     (`fulcrum/src/worker/store.rs`, `impl Store for IpcStore` at :51).
///     There is no `agent/worker/store.rs` in this checkout, so that deletion is
///     proven in `archimedes-codes/fulcrum`'s CI. What stays provable HERE is the
///     seam: drop the `IpcStore` token from `pub use fulcrum_harness::worker::{…}` in
///     `agent/worker/mod.rs` → the same three failures for `IpcStore`, because the
///     name reaches this file only through that re-export;
///   * delete the `pub use fulcrum_harness::harness::store::{DisplayRow, NoopStore,
///     Store};` line in `agent/harness/mod.rs` → this file AND the desktop's
///     `harness/**` consumers fail: the re-export seam is the other half of proof.
///
/// # ⚠️ THIS PIN'S VALUE IS LOWER THAN S4's, and that is not a defect to hide
///
/// S4's pins proved a NEW impl against a NEW trait, so compiling them was most of
/// the evidence. These two prove that the RE-PLUMBED impls still typecheck against
/// the crate trait — they do NOT prove the SQLite behaviour behind `SessionStore`
/// is unchanged, and they cannot: the trait object returns `StoreError`, and the
/// `DbError → StoreError` mapping COLLAPSES `Sqlite` into `Io`, so a variant the
/// old code distinguished is no longer visible through the seam. The behavioural
/// evidence is elsewhere and is the same evidence that existed before the split:
/// the four `SessionStore` tests that stayed with the STAYING half
/// (`agent/harness/store.rs`), `tests/harness_store.rs`, and the display/fk/upsert
/// tests relocated in S5b (`tests/persist_frames_db.rs`,
/// `tests/normalize_display_db.rs`).
#[test]
fn session_store_and_ipc_store_satisfy_the_crate_store() {
    use archimedes_lib::agent::harness::SessionStore;
    use archimedes_lib::agent::worker::IpcStore;
    use fulcrum_harness::harness::store::Store;

    fn assert_store<T: Store>() {}
    assert_store::<SessionStore>();
    assert_store::<IpcStore>();

    // The DESKTOP's spelling of the trait (through `harness/mod.rs`'s re-export,
    // which is what `harness/**` and `worker/**` import) IS the crate's trait:
    // this only compiles if the two `dyn` types are one type. A desktop-side
    // re-declaration of `Store` — the failure mode a split invites — fails HERE,
    // not at some later call site.
    fn desktop_spelling_is_the_crate_trait(
        v: &dyn archimedes_lib::agent::harness::Store,
    ) -> &dyn fulcrum_harness::harness::store::Store {
        v
    }

    // ── `SessionStore`, behind the shape the loop holds ──────────────────────
    let dir = archimedes_lib::test_support::ScratchDir::in_env_temp("fulcrum-seams-store-", "db");
    let db = Arc::new(Db::open(&dir.join("t.db")).expect("a temp db"));
    db.record_session(&SessionInfo {
        session_id: "s1".to_string(),
        cwd: std::path::PathBuf::from("/tmp"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    })
    .expect("record_session");
    let session: Arc<dyn fulcrum_harness::harness::store::Store> =
        Arc::new(SessionStore::new(db.clone()));
    // A REAL round trip through the trait object: the write and the read both go
    // through `&dyn Store`, so this is an instantiated impl, not a bound check.
    desktop_spelling_is_the_crate_trait(session.as_ref())
        .insert_message("s1", 0, "user", r#"{"role":"user","content":"hi"}"#)
        .expect("the insert goes through the crate trait");
    let loaded = session
        .load_messages("s1")
        .expect("the read goes through the crate trait");
    assert_eq!(
        loaded.len(),
        1,
        "one message round-tripped through the seam"
    );
    // The display half, through the crate's `DisplayRow` (the S4-moved type — the
    // same type on both sides is what makes the frame transportable).
    session
        .persist_display(
            "s1",
            &[DisplayRow {
                kind: "agent-text".to_string(),
                message_key: "m1".to_string(),
                payload_json: serde_json::json!({ "text": "hi" }),
                created_at: 1,
            }],
        )
        .expect("display rows go through the crate trait");
    assert_eq!(db.messages_for("s1").expect("messages").len(), 1);

    // ── `IpcStore`, behind the same shape ────────────────────────────────────
    let (tx, mut rx) =
        tokio::sync::mpsc::unbounded_channel::<archimedes_lib::agent::worker::protocol::Outbound>();
    let ipc: Arc<dyn fulcrum_harness::harness::store::Store> = Arc::new(IpcStore::new(tx));
    desktop_spelling_is_the_crate_trait(ipc.as_ref())
        .insert_message("s1", 3, "assistant", r#"{"role":"assistant"}"#)
        .expect("the frame send never fails (unbounded)");
    match rx.try_recv().expect("the frame is on the channel") {
        archimedes_lib::agent::worker::protocol::Outbound::TranscriptInsert {
            seq, role, ..
        } => {
            assert_eq!(
                (seq, role.as_str()),
                (3, "assistant"),
                "the frame carries the call"
            );
        }
        other => panic!("expected TranscriptInsert, got {other:?}"),
    }
    // The `load_messages` arm the Worker's store documents as a DEFENSIVE error
    // — asserted through the trait object, so the mapping is the crate's
    // `StoreError`, not the desktop's.
    let err = ipc.load_messages("s1").expect_err("write-only by design");
    assert!(
        matches!(err, StoreError::Io(_)),
        "the write-only arm reports `StoreError::Io` — got {err}"
    );
    drop(dir);
}
