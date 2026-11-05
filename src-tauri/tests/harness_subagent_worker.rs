//! The `subagent` / `dispatch` tests that drive a REAL `WorkerManager`
//! (T5/S5b relocation, from `crates/fulcrum-core/src/subagent.rs` and
//! `crates/fulcrum-core/src/harness/dispatch.rs`).
//!
//! # Why these eight relocated rather than re-pointing at a crate-side double
//!
//! `subagent.rs` and `harness/dispatch.rs` moved to the crate in S5b, but the
//! types these tests build their fixtures on — `WorkerManager`, `WorkerFactory`,
//! `WorkerHandle`, `WorkerError`, `WorkerInboundEvent` — live in `worker/`, which
//! STAYS DESKTOP THROUGH T8. They do not resolve inside `fulcrum-core` at all, and
//! they are five of the fourteen compile errors this commit fixes.
//!
//! A crate-side `Dispatcher` double was considered and REJECTED for these eight,
//! because what each asserts is a property the DESKTOP's `WorkerManager::
//! dispatch_subagent` flow produces, delivered over a real `fake_worker` child
//! process:
//!
//!   * `Completed` carries the `SubagentCapture`'s final text, which is built from
//!     the CHILD's `SinkFrame` `agent_message_chunk` stream — a double would emit
//!     whatever the test handed it, so the capture code could be deleted and the
//!     pin would stay green;
//!   * a crash is `Failed` WITH THE EXIT CODE (`code 137`) — the exit code comes
//!     from a real process wait;
//!   * the **Dead bound** reaps a silent child WITHIN THE BOUND — a timer the
//!     `WorkerManager` owns;
//!   * `cancel()` aborts an in-flight dispatch and the `subagent-closed` payload
//!     says `"cancelled"` rather than `"unresponsive"` — which arm wins is
//!     `WorkerManager` logic;
//!   * the child's `Start` envelope carries the recursion-guarded `enabledTools`,
//!     the derived `systemPrompt` and the inherited `trusted` flag — all three are
//!     computed in `subagent_flow.rs`, on the desktop side of the seam.
//!
//! Feeding those through a double the test itself implements converts each
//! assertion into a restatement of the fixture. So they relocate, per Step D and
//! the S2 `skill_catalog_drift.rs` / S5a `permission_gate_db.rs` precedent: a test
//! that spans the boundary lives on the side that can see both halves. NO NEW
//! SEAM WAS INVENTED to avoid this — the crate's `Dispatcher` trait already
//! existed (S4) and is what PRODUCTION is wired through; it is simply not a
//! substitute for the thing under test.
//!
//! # What stayed in the crate, and why that is not inconsistent
//!
//! `dispatch_native_without_a_worker_manager_fails_immediately` names no worker
//! type at all and stayed. `set_worker_manager_is_set_once_on_the_manager` and
//! `subagent_cancel_variants_are_well_behaved` RE-POINTED at a `Dispatcher` double
//! in place, because their claim is about the crate's own `OnceLock` and its own
//! `SubagentCancel::cancel()` routing — the double is the thing-under-test's only
//! collaborator there, so naming it is not circular. The split is per claim, not
//! per file.
//!
//! # Fixture path
//!
//! The crate copies resolved the `fake_worker` binary as
//! `CARGO_MANIFEST_DIR.parent()/target/debug/fake_worker`, which was correct while
//! these files lived in `src-tauri/` and became WRONG on the move (from
//! `crates/fulcrum-core` one `.parent()` is `…/crates`). Here the integration
//! target uses `CARGO_BIN_EXE_fake_worker`, the `tests/worker_stderr.rs` idiom —
//! the S3 Step A-bis trap, avoided rather than inherited.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use tokio::sync::oneshot;

use archimedes_lib::agent::harness::{
    InProcessDispatcher, Model, ModelCatalog, SubagentDispatcher,
};
use archimedes_lib::agent::subagent::{
    AgentNameResolution, LaunchConfig, SubagentCancel, SubagentFailureReason, SubagentOutcome,
    SubagentSessionManager,
};
use archimedes_lib::agent::worker::client::{WorkerError, WorkerHandle, WorkerInboundEvent};
use archimedes_lib::agent::worker::manager::{WorkerFactory, WorkerManager};
use archimedes_lib::agent::worker::protocol::{StartEnv, StartMode};
use archimedes_lib::agent::EventSink;

type SinkEvents = Arc<StdMutex<Vec<(String, serde_json::Value)>>>;
type EventLog = Arc<StdMutex<Vec<(String, bool, WorkerInboundEvent)>>>;
type SinkMap = Arc<StdMutex<HashMap<String, Arc<CollectorSink>>>>;

/// The `fake_worker` fixture factory (`CARGO_BIN_EXE_fake_worker` — see the
/// module docs for why not the crate copy's `.parent()` arithmetic).
struct FakeWorkerFactory;

impl WorkerFactory for FakeWorkerFactory {
    fn spawn(&self) -> Result<WorkerHandle, WorkerError> {
        WorkerHandle::spawn(&PathBuf::from(env!("CARGO_BIN_EXE_fake_worker")))
    }
}

/// A UI sink collector (the parent-scope `TauriSink` test double).
#[derive(Clone)]
struct CollectorSink {
    events: SinkEvents,
}

impl CollectorSink {
    fn new() -> (Self, SinkEvents) {
        let events = Arc::new(StdMutex::new(Vec::new()));
        (
            Self {
                events: events.clone(),
            },
            events,
        )
    }
}

impl EventSink for CollectorSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        self.events
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push((event.to_string(), payload));
    }
}

/// A no-op `EventSink` (the `dispatch` signature's `sink` parameter — the
/// `dispatch_native` re-plumb's no-op; the lifecycle events ride the
/// `WorkerManager`'s `sink_for` lookup).
struct NoopSink;
impl EventSink for NoopSink {
    fn emit(&self, _event: &str, _payload: serde_json::Value) {}
}

/// A test `Model` (a fake provider — the `fake_worker`'s `model_key` `fake/m1`
/// resolves against the parent's catalog).
fn test_model(id: &str, thinking_levels: Vec<String>) -> Model {
    Model {
        id: id.to_string(),
        provider: "fake".to_string(),
        base_url: "http://fake/v1".to_string(),
        api_key: "k".to_string(),
        context_window: 100_000,
        cost_per_mtok_in: 0.0,
        cost_per_mtok_out: 0.0,
        supports_tools: true,
        supports_thinking: !thinking_levels.is_empty(),
        thinking_levels,
        api: Some("openai-completions".to_string()),
    }
}

/// A parent `StartEnv` (the `dispatch_subagent` flow reads the
/// effective `catalog` / `config_dir` / `trusted` from it — the
/// Supervisor owns them).
fn test_env(
    session_id: &str,
    models: Vec<Model>,
    enabled_tools: Option<Vec<String>>,
    trusted: bool,
) -> StartEnv {
    StartEnv::from_parts(
        session_id.to_string(),
        "/tmp/space".to_string(),
        StartMode::Fresh,
        None,
        models
            .first()
            .cloned()
            .unwrap_or_else(|| test_model("m1", Vec::new())),
        ModelCatalog {
            models,
            ..Default::default()
        },
        None,
        trusted,
        enabled_tools,
        "/tmp/config".to_string(),
        true,
        None,
        // (issue #101) A parent/worker-side start (no definition involved) —
        // `None` = no per-agent narrowing.
        None,
    )
}

/// A `SubagentSessionManager` on a `WorkerManager` (the
/// `dispatch_native` re-plumb — the subagent runs in a
/// `fake_worker` process): the parent `p1` is `attach`ed with the
/// given `StartEnv` (the flow's `catalog` / `trusted` source) + the
/// parent-scope sink is registered (the
/// `subagent-session-started` / `subagent-closed` lifecycle events).
async fn make_manager(
    dead_bound: Option<Duration>,
    parent_env: StartEnv,
) -> (
    Arc<SubagentSessionManager>,
    Arc<WorkerManager>,
    SinkEvents,
    EventLog,
) {
    let (sink, sink_events) = CollectorSink::new();
    let events: EventLog = Arc::new(StdMutex::new(Vec::new()));
    let sinks: SinkMap = Arc::new(StdMutex::new(HashMap::new()));
    {
        let mut m = sinks.lock().unwrap_or_else(|p| p.into_inner());
        m.insert("p1".to_string(), Arc::new(sink));
    }
    let factory: Arc<dyn WorkerFactory> = Arc::new(FakeWorkerFactory);
    let events_c = events.clone();
    let manager = WorkerManager::new(
        factory,
        Arc::new(|_id: String, _code: Option<i32>, _pid: Option<u32>| {}),
        Arc::new(
            move |id: String, is_subagent: bool, evt: WorkerInboundEvent| {
                events_c
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .push((id, is_subagent, evt));
            },
        ),
        Arc::new(move |id: &str| {
            sinks
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(id)
                .cloned()
                .map(|s| s as Arc<dyn EventSink>)
        }),
    );
    let manager = match dead_bound {
        Some(t) => manager.with_dead_bound(t),
        None => manager,
    };
    let wm = Arc::new(manager);
    wm.attach("p1", &parent_env)
        .await
        .expect("the parent attach completes");
    let manager = Arc::new(SubagentSessionManager::new());
    manager.set_dispatcher(wm.clone());
    (manager, wm, sink_events, events)
}

/// A `dispatch_native` call (the `SubagentSessionManager` → the
/// `WorkerManager` flow — the subagent runs in a `fake_worker`
/// process). The `sink` parameter is the re-plumb's no-op (the
/// lifecycle events ride the `sink_for` lookup — the `CollectorSink`
/// registered in `make_manager`).
fn dispatch(
    manager: &SubagentSessionManager,
    launch: LaunchConfig,
    task: &str,
    parent_enabled_tools: Vec<String>,
    parent_model: &Model,
) -> (oneshot::Receiver<SubagentOutcome>, SubagentCancel) {
    let sink: Arc<dyn EventSink> = Arc::new(CollectorSink::new().0);
    manager.dispatch_native(
        "p1",
        std::path::Path::new("/tmp/space"),
        parent_model,
        parent_enabled_tools,
        "tester".to_string(),
        // The fixture names an Agent; nothing here asserts on the
        // resolution (the tri-state's own pins live in
        // `harness::launch` and the `subagent_flow` tests).
        AgentNameResolution::Matched,
        launch,
        task.to_string(),
        &sink,
    )
}

/// Bounded-await the dispatch outcome (a missing resolution is a test
/// failure, not a hang).
async fn outcome(rx: oneshot::Receiver<SubagentOutcome>, timeout: Duration) -> SubagentOutcome {
    tokio::time::timeout(timeout, rx)
        .await
        .expect("the dispatch must resolve (the teardown cannot hang)")
        .expect("the oneshot must not be dropped")
}

/// Bounded-wait until the `on_event` deliveries for `session_id`
/// contain a frame matching `pred` (a deadline, so a missing frame
/// is a test failure, not a hang).
async fn wait_for_event(
    events: &EventLog,
    session_id: &str,
    pred: impl Fn(&WorkerInboundEvent) -> bool,
) -> Vec<(bool, WorkerInboundEvent)> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let got = events
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .filter(|(id, _, _)| id == session_id)
            .map(|(_, is_sub, evt)| (*is_sub, evt.clone()))
            .collect::<Vec<_>>();
        if got.iter().any(|(_, e)| pred(e)) || tokio::time::Instant::now() >= deadline {
            return got;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// (1) **the core (the re-plumb)**: `dispatch_native` (the
/// `WorkerManager` flow) spawns a subagent WORKER (a
/// `fake_worker` process — NOT an in-process `AgentLoop`), runs the
/// task, and resolves `Completed` with the `SubagentCapture`'s final
/// text (the `SinkFrame` `agent_message_chunk` source — the
/// `last_message_id`'s accumulated text). The `subagent-closed`
/// lifecycle event fires on the parent's sink.
#[tokio::test]
async fn dispatch_native_resolves_completed_with_the_captured_final_text() {
    let (manager, wm, sink_events, events) = make_manager(
        Some(Duration::from_secs(30)),
        test_env("p1", vec![test_model("m1", Vec::new())], None, true),
    )
    .await;
    let (dispatch_rx, _cancel) = dispatch(
        &manager,
        LaunchConfig::default(),
        "do the thing",
        Vec::new(),
        &test_model("m1", Vec::new()),
    );
    let outcome = outcome(dispatch_rx, Duration::from_secs(30)).await;
    match outcome {
        SubagentOutcome::Completed { output, metrics } => {
            assert_eq!(
                output, "canned answer",
                "the `SubagentCapture`'s final text (the `SinkFrame` `agent_message_chunk` source)"
            );
            assert!(metrics.duration_ms >= 1, "the wall clock (ms)");
        }
        other => panic!("expected `Completed`, got {other:?}"),
    }
    // The `subagent-closed` lifecycle event fired on the PARENT's
    // sink (the `subagent-session-started` / `subagent-closed` UI
    // contract — the `SubagentCapture`'s metrics ride verbatim).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let got: Vec<(String, serde_json::Value)> = loop {
        let got = sink_events
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if got.iter().any(|(e, _)| e == "subagent-closed")
            || tokio::time::Instant::now() >= deadline
        {
            break got;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let started = got
        .iter()
        .find(|(e, _)| e == "subagent-session-started")
        .map(|(_, p)| p.clone())
        .expect("the `subagent-session-started` fired on the parent's sink");
    assert_eq!(started["parentSessionId"], "p1");
    assert_eq!(
        started["model"], "fake/m1",
        "the parent's model (the `model_key`)"
    );
    let closed = got
        .iter()
        .find(|(e, _)| e == "subagent-closed")
        .map(|(_, p)| p.clone())
        .expect("the `subagent-closed` fired on the parent's sink");
    assert_eq!(closed["status"], "completed");
    assert_eq!(closed["sessionId"], started["sessionId"], "the same child");
    // The subagent Worker ran (a fresh ephemeral session — its
    // frames reached the router with `is_subagent: true`).
    let got = wait_for_event(&events, "p1", |e| {
        matches!(
            e,
            WorkerInboundEvent::SinkFrame { event, .. }
                if event == "session-update"
        )
    })
    .await;
    assert!(
        got.iter().any(|(is_sub, _)| *is_sub),
        "a subagent Worker's frames reached the router with the flag: {got:?}"
    );
    wm.detach("p1");
}

/// (2) **crash**: a subagent WORKER that crashes (a `__crash__` task
/// — the `fake_worker` exits 137) is a `Failed` with the EXIT CODE in
/// the error (NOT `Completed` — the process exit is the crash signal),
/// + `subagent-closed { status: "failed" }`.
#[tokio::test]
async fn dispatch_native_a_crashed_child_is_failed_with_the_exit_code() {
    let (manager, wm, sink_events, _events) = make_manager(
        Some(Duration::from_secs(30)),
        test_env("p1", vec![test_model("m1", Vec::new())], None, true),
    )
    .await;
    let (dispatch_rx, _cancel) = dispatch(
        &manager,
        LaunchConfig::default(),
        "__crash__",
        Vec::new(),
        &test_model("m1", Vec::new()),
    );
    let outcome = outcome(dispatch_rx, Duration::from_secs(30)).await;
    match outcome {
        SubagentOutcome::Failed { error, .. } => {
            assert_eq!(
                error, "subagent worker exited unexpectedly (code 137)",
                "the crash carries the EXIT CODE in the error"
            );
        }
        other => panic!("expected `Failed` (crash), got {other:?}"),
    }
    // The `subagent-closed` lifecycle event fired (EVERY exit path —
    // the crash included) with the failure.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let got: Vec<(String, serde_json::Value)> = loop {
        let got = sink_events
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if got.iter().any(|(e, _)| e == "subagent-closed")
            || tokio::time::Instant::now() >= deadline
        {
            break got;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let closed = got
        .iter()
        .find(|(e, _)| e == "subagent-closed")
        .map(|(_, p)| p.clone())
        .expect("the `subagent-closed` fired (every exit path)");
    assert_eq!(closed["status"], "failed");
    assert_eq!(
        closed["error"],
        "subagent worker exited unexpectedly (code 137)"
    );
    wm.detach("p1");
}

/// (3) **`dead_bound`**: a subagent WORKER whose turn HANGS (a
/// `__slow__` task — the `fake_worker` sleeps 10 s before settling) is
/// SILENT with NOTHING in flight, so the flow's **Dead bound** reaps it
/// (the bound is SHORTER than the 10 s sleep):
/// `Failed { reason: Unresponsive, error: "unresponsive" }` +
/// `subagent-closed { status: "failed" }`, WITHIN THE BOUND.
#[tokio::test]
async fn dispatch_native_a_slow_child_hits_the_dead_bound() {
    let (manager, wm, _sink_events, _events) = make_manager(
        Some(Duration::from_secs(1)),
        test_env("p1", vec![test_model("m1", Vec::new())], None, true),
    )
    .await;
    let (dispatch_rx, _cancel) = dispatch(
        &manager,
        LaunchConfig::default(),
        "__slow__",
        Vec::new(),
        &test_model("m1", Vec::new()),
    );
    let outcome = outcome(dispatch_rx, Duration::from_secs(10)).await;
    assert!(
        matches!(
            outcome,
            SubagentOutcome::Failed {
                reason: SubagentFailureReason::Unresponsive,
                ref error,
                ..
            } if error == "unresponsive"
        ),
        "a silent child is reaped as `Failed` (unresponsive) — got {outcome:?}"
    );
    wm.detach("p1");
}

/// (4) **`SubagentCancel`**: a parent-turn cancel (the
/// `SubagentCancel` handle's `cancel()` — the loop's
/// `dispatch_subagent` `turn.cancelled()` arm calls it) aborts the
/// in-flight dispatch (the `WorkerManager`'s `cancel_subagent` — the
/// `send_abort` + the drive's `Cancelled` outcome + the reap):
/// `Failed { "cancelled" }` + `subagent-closed { error: "cancelled"
/// }`, WITHIN THE BOUND (a `__slow__` child would otherwise run out
/// the `dead_bound` — the 30 s bound proves the CANCEL arm, not
/// the **Dead bound**, wins).
#[tokio::test]
async fn dispatch_native_cancel_aborts_the_dispatch() {
    let (manager, wm, _sink_events, _events) = make_manager(
        Some(Duration::from_secs(30)),
        test_env("p1", vec![test_model("m1", Vec::new())], None, true),
    )
    .await;
    let (dispatch_rx, cancel) = dispatch(
        &manager,
        LaunchConfig::default(),
        "__slow__",
        Vec::new(),
        &test_model("m1", Vec::new()),
    );
    // Let the child start (the `fake_worker`'s 10 s sleep is in
    // flight), then CANCEL (the `WorkerManager`'s `cancel_subagent`
    // — the `send_abort` + the drive's `cancel` flag).
    tokio::time::sleep(Duration::from_millis(500)).await;
    cancel.cancel();
    let outcome = outcome(dispatch_rx, Duration::from_secs(10)).await;
    assert!(
        matches!(
            outcome,
            SubagentOutcome::Failed { ref error, .. } if error == "cancelled"
        ),
        "a cancel settles `Failed` (cancelled) — got {outcome:?}"
    );
    wm.detach("p1");
}

/// (8) **the recursion guard (the re-plumb)**: a child's
/// `enabledTools` (the `Start` envelope — the `fake_worker`'s
/// `session-update` `enabledTools` echo) NEVER contains `subagent`
/// (the recursion guard) nor `list_agents` (a child cannot dispatch,
/// so listing dispatch targets is pointless token burn) — even when
/// the PARENT's enabled tools carry `list_agents` (the three-way
/// rule's inherited-parent branch — the `WorkerManager`'s flow).
#[tokio::test]
async fn a_child_excludes_subagent_and_list_agents_tools() {
    let (manager, wm, _sink_events, events) = make_manager(
        Some(Duration::from_secs(30)),
        test_env("p1", vec![test_model("m1", Vec::new())], None, true),
    )
    .await;
    let (dispatch_rx, _cancel) = dispatch(
        &manager,
        LaunchConfig::default(),
        "do the thing",
        vec!["read".to_string(), "list_agents".to_string()],
        &test_model("m1", Vec::new()),
    );
    // AWAIT the outcome BEFORE asserting (the child's `Start` frame
    // — the advertised `enabledTools` — is emitted before the
    // settle; the `await` guarantees it is present).
    let _ = outcome(dispatch_rx, Duration::from_secs(30)).await;
    // The child's advertised tool set (the `Start` → the
    // `fake_worker`'s `session-update` `enabledTools` frame — the
    // `is_subagent` events).
    let got = wait_for_event(&events, "p1", |e| {
        matches!(
            e,
            WorkerInboundEvent::SinkFrame { event, .. }
                if event == "session-update"
        )
    })
    .await;
    let child_enabled = got
        .iter()
        .find_map(|(is_sub, e)| {
            if !is_sub {
                return None;
            }
            match e {
                WorkerInboundEvent::SinkFrame { payload, .. } => payload
                    .get("update")
                    .and_then(|u| u.get("enabledTools"))
                    .cloned(),
                _ => None,
            }
        })
        .expect("the child advertised its tool set");
    assert_eq!(
        child_enabled,
        serde_json::json!(["read"]),
        "the child's `enabledTools` never contains `subagent` or `list_agents` (the three-way rule's inherited-parent branch)"
    );
    wm.detach("p1");
}

/// (9) **the child's system message (the re-plumb — the `system_prompt`
/// ENVELOPE field)**: the `build_child_system_message` computation
/// (the `launch.system_prompt` + the todo guidance line — the
/// `has_todo_tool` derivation from the resolved child tool list) rides
/// the `Start` envelope (the `fake_worker`'s `systemPrompt` echo —
/// the child's seq-0 transcript row is the Supervisor's
/// `TranscriptPersister`'s `is_subagent` row): `Some` prompt + the
/// todo tool → the prompt + the todo line; `Some` prompt + NO todo
/// tool → the prompt VERBATIM; `None` + the todo tool → the todo line
/// ALONE; `None` + NO todo tool → `None` (no system message).
#[tokio::test]
async fn the_child_system_prompt_rides_the_start_envelope() {
    let m1 = test_model("m1", Vec::new());
    // Case 1: `Some` prompt + `launch.tools: None` + the FULL parent
    // tool set (the child HAS `manage_todo_list`) → the prompt + the
    // todo line.
    let (manager, wm, _sink_events, events) = make_manager(
        Some(Duration::from_secs(30)),
        test_env("p1", vec![m1.clone()], None, true),
    )
    .await;
    let (dispatch_rx, _cancel) = dispatch(
        &manager,
        LaunchConfig {
            system_prompt: Some("You are a careful reviewer.".to_string()),
            ..Default::default()
        },
        "do the thing",
        Vec::new(),
        &m1,
    );
    let _ = outcome(dispatch_rx, Duration::from_secs(30)).await;
    let got = wait_for_event(&events, "p1", |e| {
        matches!(
            e,
            WorkerInboundEvent::SinkFrame { event, .. }
                if event == "session-update"
        )
    })
    .await;
    let system_prompt = got
        .iter()
        .find_map(|(is_sub, e)| {
            if !is_sub {
                return None;
            }
            match e {
                WorkerInboundEvent::SinkFrame { payload, .. } => payload
                    .get("update")
                    .and_then(|u| u.get("systemPrompt"))
                    .cloned(),
                _ => None,
            }
        })
        .expect("the child's `systemPrompt` rides the `Start` envelope");
    assert_eq!(
        system_prompt,
        serde_json::json!("You are a careful reviewer.\nUse manage_todo_list to track multi-step work — write the plan before starting, mark items completed as you go"),
        "`Some` prompt + the todo tool → the prompt + the todo line"
    );
    wm.detach("p1");

    // Case 2: `Some` prompt + NO `manage_todo_list` (the child's
    // tools = the parent's minus `subagent`) → the prompt VERBATIM.
    let (manager, wm, _sink_events, events) = make_manager(
        Some(Duration::from_secs(30)),
        test_env("p1", vec![m1.clone()], None, true),
    )
    .await;
    let (dispatch_rx, _cancel) = dispatch(
        &manager,
        LaunchConfig {
            system_prompt: Some("You are a careful reviewer.".to_string()),
            ..Default::default()
        },
        "do the thing",
        vec!["read".to_string(), "bash".to_string()],
        &m1,
    );
    let _ = outcome(dispatch_rx, Duration::from_secs(30)).await;
    let got = wait_for_event(&events, "p1", |e| {
        matches!(
            e,
            WorkerInboundEvent::SinkFrame { event, .. }
                if event == "session-update"
        )
    })
    .await;
    let system_prompt = got
        .iter()
        .find_map(|(is_sub, e)| {
            if !is_sub {
                return None;
            }
            match e {
                WorkerInboundEvent::SinkFrame { payload, .. } => payload
                    .get("update")
                    .and_then(|u| u.get("systemPrompt"))
                    .cloned(),
                _ => None,
            }
        })
        .expect("the child's `systemPrompt` rides the `Start` envelope");
    assert_eq!(
        system_prompt,
        serde_json::json!("You are a careful reviewer."),
        "`Some` prompt + NO todo tool → the prompt VERBATIM"
    );
    wm.detach("p1");

    // Case 3: `None` prompt + the todo tool → the todo line ALONE.
    let (manager, wm, _sink_events, events) = make_manager(
        Some(Duration::from_secs(30)),
        test_env("p1", vec![m1.clone()], None, true),
    )
    .await;
    let (dispatch_rx, _cancel) = dispatch(
        &manager,
        LaunchConfig::default(),
        "do the thing",
        Vec::new(),
        &m1,
    );
    let _ = outcome(dispatch_rx, Duration::from_secs(30)).await;
    let got = wait_for_event(&events, "p1", |e| {
        matches!(
            e,
            WorkerInboundEvent::SinkFrame { event, .. }
                if event == "session-update"
        )
    })
    .await;
    let system_prompt = got
        .iter()
        .find_map(|(is_sub, e)| {
            if !is_sub {
                return None;
            }
            match e {
                WorkerInboundEvent::SinkFrame { payload, .. } => payload
                    .get("update")
                    .and_then(|u| u.get("systemPrompt"))
                    .cloned(),
                _ => None,
            }
        })
        .expect("the child's `systemPrompt` rides the `Start` envelope");
    assert_eq!(
        system_prompt,
        serde_json::json!("Use manage_todo_list to track multi-step work — write the plan before starting, mark items completed as you go"),
        "`None` prompt + the todo tool → the todo line ALONE"
    );
    wm.detach("p1");

    // Case 4: `None` prompt + NO todo tool → `None` (NO system
    // message — the child's seq-0 row is absent, and now PROVABLY so:
    // the envelope's `mode` is `FreshChild`, so the worker's
    // `(StartMode::FreshChild, None)` arm prepends NOTHING instead of
    // falling through to the main-prompt arm — issue #9).
    let (manager, wm, _sink_events, events) = make_manager(
        Some(Duration::from_secs(30)),
        test_env("p1", vec![m1.clone()], None, true),
    )
    .await;
    let (dispatch_rx, _cancel) = dispatch(
        &manager,
        LaunchConfig::default(),
        "do the thing",
        vec!["read".to_string(), "bash".to_string()],
        &m1,
    );
    let _ = outcome(dispatch_rx, Duration::from_secs(30)).await;
    let got = wait_for_event(&events, "p1", |e| {
        matches!(
            e,
            WorkerInboundEvent::SinkFrame { event, .. }
                if event == "session-update"
        )
    })
    .await;
    let system_prompt = got
        .iter()
        .find_map(|(is_sub, e)| {
            if !is_sub {
                return None;
            }
            match e {
                WorkerInboundEvent::SinkFrame { payload, .. } => payload
                    .get("update")
                    .and_then(|u| u.get("systemPrompt"))
                    .cloned(),
                _ => None,
            }
        })
        .expect(
            "the `Start` envelope's `systemPrompt` field is present (the `fake_worker`'s echo)",
        );
    assert!(
        system_prompt.is_null(),
        "`None` prompt + NO todo tool → `None` (no system message): {system_prompt:?}"
    );
    wm.detach("p1");
}

/// (10) **trust inheritance (the re-plumb — the ADR 0010
/// `trusted` ENVELOPE field)**: a child's `Start` envelope carries
/// the PARENT Space's trust flag (the `WorkerManager`'s flow threads
/// `parent_env.trusted` verbatim — the Supervisor owns the `spaces`
/// table): a TRUSTED parent Space → `trusted: true` (the child's
/// permission gate auto-approves mutating tools); a NON-trusted
/// parent → `trusted: false` (fail-closed — the gate prompts).
#[tokio::test]
async fn a_trusted_parent_space_inherits_onto_the_child_env() {
    let m1 = test_model("m1", Vec::new());
    // A TRUSTED parent Space → the child's `Start` envelope carries
    // `trusted: true` (the child's permission gate auto-approves
    // mutating tools).
    let (manager, wm, _sink_events, events) = make_manager(
        Some(Duration::from_secs(30)),
        test_env("p1", vec![m1.clone()], None, true),
    )
    .await;
    let (dispatch_rx, _cancel) = dispatch(
        &manager,
        LaunchConfig::default(),
        "do the thing",
        Vec::new(),
        &m1,
    );
    let _ = outcome(dispatch_rx, Duration::from_secs(30)).await;
    let got = wait_for_event(&events, "p1", |e| {
        matches!(
            e,
            WorkerInboundEvent::SinkFrame { event, .. }
                if event == "session-update"
        )
    })
    .await;
    let trusted = got
        .iter()
        .find_map(|(is_sub, e)| {
            if !is_sub {
                return None;
            }
            match e {
                WorkerInboundEvent::SinkFrame { payload, .. } => payload
                    .get("update")
                    .and_then(|u| u.get("trusted"))
                    .cloned(),
                _ => None,
            }
        })
        .expect("the child's `trusted` flag rides the `Start` envelope");
    assert_eq!(
        trusted,
        serde_json::json!(true),
        "a TRUSTED parent Space → the child's `Start` envelope carries `trusted: true`"
    );
    wm.detach("p1");

    // A NON-trusted parent Space → `trusted: false` (fail-closed).
    let (manager, wm, _sink_events, events) = make_manager(
        Some(Duration::from_secs(30)),
        test_env("p1", vec![m1.clone()], None, false),
    )
    .await;
    let (dispatch_rx, _cancel) = dispatch(
        &manager,
        LaunchConfig::default(),
        "do the thing",
        Vec::new(),
        &m1,
    );
    let _ = outcome(dispatch_rx, Duration::from_secs(30)).await;
    let got = wait_for_event(&events, "p1", |e| {
        matches!(
            e,
            WorkerInboundEvent::SinkFrame { event, .. }
                if event == "session-update"
        )
    })
    .await;
    let trusted = got
        .iter()
        .find_map(|(is_sub, e)| {
            if !is_sub {
                return None;
            }
            match e {
                WorkerInboundEvent::SinkFrame { payload, .. } => payload
                    .get("update")
                    .and_then(|u| u.get("trusted"))
                    .cloned(),
                _ => None,
            }
        })
        .expect("the child's `trusted` flag rides the `Start` envelope");
    assert_eq!(
        trusted,
        serde_json::json!(false),
        "a NON-trusted parent Space → the child's `Start` envelope carries `trusted: false` (fail-closed)"
    );
    wm.detach("p1");
}

// ── from `crates/fulcrum-core/src/harness/dispatch.rs` ───────────────────────
//
// `dispatch.rs`'s ONE `WorkerManager`-backed test. The file's other six tests
// drive the crate's own `MockDispatcher` and stayed in the crate; this one builds
// a real `WorkerManager` + `fake_worker` child, for the same reason and with the
// same consequence as the seven above. It is the pin for
// `InProcessDispatcher::dispatch` — the `AgentLoop`'s `subagent` seam delegating
// to the `Dispatcher` trait and the returned `SubagentCancel` handle being
// idempotent.

/// A `SubagentSessionManager` on a `WorkerManager` (the ADR 0025 Task 5
/// re-plumb — the `dispatch_native` delegation to the `WorkerManager`'s
/// `dispatch_subagent` flow): the parent `parent-1` is `attach`ed with a
/// single-model catalog (the `dispatch_subagent` flow resolves the child's
/// `model` against it), and the `sink_for` lookup returns `None` (the
/// lifecycle events are not asserted on here — the oneshot is the
/// observation point).
async fn make_dispatch_manager() -> Arc<SubagentSessionManager> {
    let factory: Arc<dyn WorkerFactory> = Arc::new(FakeWorkerFactory);
    let wm = Arc::new(
        WorkerManager::new(
            factory,
            Arc::new(|_id: String, _code: Option<i32>, _pid: Option<u32>| {}),
            Arc::new(|_id: String, _is_subagent: bool, _evt: WorkerInboundEvent| {}),
            Arc::new(|_id: &str| None),
        )
        .with_dead_bound(Duration::from_secs(30)),
    );
    let env = StartEnv::from_parts(
        "parent-1".to_string(),
        "/tmp/space".to_string(),
        StartMode::Fresh,
        None,
        test_model("m1", Vec::new()),
        ModelCatalog {
            models: vec![test_model("m1", Vec::new())],
            ..Default::default()
        },
        None,
        true,
        None,
        "/tmp/config".to_string(),
        true,
        None,
        // (issue #101) `from_parts`' new trailing arg (parent fixture: no block).
        None,
    );
    wm.attach("parent-1", &env)
        .await
        .expect("the parent attach completes");
    let manager = Arc::new(SubagentSessionManager::new());
    manager.set_dispatcher(wm);
    manager
}

/// `InProcessDispatcher::dispatch` on a `SubagentSessionManager` (the
/// ADR 0025 Task 5 re-plumb — the `dispatch_native` delegation to the
/// `WorkerManager`'s `dispatch_subagent` flow — a `fake_worker` child
/// settles) resolves the oneshot (`Completed` — the `SubagentCapture`'s
/// final text), and returns the `SubagentCancel` handle (its `cancel()` is
/// idempotent — the `WorkerManager`'s `cancel_subagent` for a gone drive is
/// a no-op).
#[tokio::test]
async fn in_process_dispatcher_resolves_the_oneshot() {
    let manager = make_dispatch_manager().await;
    let dispatcher = InProcessDispatcher::new(manager);
    let sink: Arc<dyn EventSink> = Arc::new(NoopSink);
    let cwd = std::env::temp_dir();
    let (rx, cancel) = dispatcher.dispatch(
        "parent-1",
        &cwd,
        &test_model("m1", Vec::new()),
        Vec::new(),
        "tester".to_string(),
        // A real `InProcessDispatcher` + a named Agent: the truthful value
        // for this fixture (nothing here asserts on the resolution).
        AgentNameResolution::Matched,
        LaunchConfig::default(),
        "do the thing".to_string(),
        &sink,
    );
    // The oneshot resolves `Completed` (the `fake_worker` child
    // settles — the `SubagentCapture`'s final text — the
    // `dispatch_native` re-plumb's delegation works end-to-end).
    let outcome = tokio::time::timeout(Duration::from_secs(10), rx)
        .await
        .expect("the oneshot resolved within the bound")
        .expect("the oneshot was not dropped");
    assert!(
        matches!(outcome, SubagentOutcome::Completed { .. }),
        "a settling child resolves `Completed` — got {outcome:?}"
    );
    // The `SubagentCancel` handle is returned + idempotent (the
    // `WorkerManager`'s `cancel_subagent` — a gone drive is a no-op).
    cancel.cancel();
    cancel.cancel();
}
