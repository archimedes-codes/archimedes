//! The `harness::r#loop` subagent tests that need a REAL `WorkerManager`
//! (T5/S5b relocation, from `crates/fulcrum-core/src/harness/loop/tests/subagents.rs`).
//!
//! # Why these five relocated and the other nine did not
//!
//! `harness::r#loop` moved to the crate in S5b, and so did this file's nine
//! siblings — the ones that drive the loop through the crate's own
//! `MockDispatcher` seam. These FIVE build their `SubagentSessionManager` on a
//! real `WorkerManager` spawning real `fake_worker` child processes, and
//! `worker/` STAYS DESKTOP THROUGH T8. So the crate cannot name the fixture's
//! central type at all: `crate::agent::worker::manager::WorkerManager` does not
//! resolve inside `fulcrum-core`, which is one of the fourteen compile errors
//! this commit fixes.
//!
//! They could not be re-pointed at a crate-side double honestly. What each one
//! asserts is the `subagent-session-started` payload the DESKTOP's
//! `WorkerManager::dispatch_subagent` flow emits — the resolved model key, the
//! `:<level>` thinking suffix, the `AgentNameResolution` tri-state, the trimmed
//! `agentName`. A crate-side `Dispatcher` double would emit whatever the test
//! told it to, which makes every one of those assertions tautological: the pin
//! would survive deleting the resolution code inside `subagent_flow.rs`. Per the
//! brief's rule — do not invent a seam to avoid a relocation — these go to the
//! side that can see both halves (Step D, and S2's `skill_catalog_drift.rs` /
//! S5a's `permission_gate_db.rs`).
//!
//! # What travelled with them
//!
//! The `FakeWorkerFactory` / `make_worker_manager` / `make_subagent_manager`
//! fixtures and the `ScriptedProvider` / `RecordingSink` /
//! `build_loop_with_dispatcher` / `wait_for_event` / `text_prompt` /
//! `fake_model` helpers, re-expressed against the desktop's re-export paths. The
//! assertions are VERBATIM; the edits are paths, plus `CARGO_MANIFEST_DIR
//! .parent()` → `CARGO_BIN_EXE_fake_worker` (the S3 Step A-bis fix — from
//! `crates/fulcrum-core` a single `.parent()` is `…/crates`, so the fixture path
//! those tests carried would have named `crates/target/debug/fake_worker` and
//! failed with ENOENT; an integration target gets the path from cargo instead).
//!
//! The ninth test in the source file that reads a `settings.json`
//! (`a_native_subagent_with_a_settings_override_runs_the_override_model`) keeps
//! its `load_settings` call — the ADR 0066 `subagentModels` → `agent_overrides`
//! FOLD is the desktop loader's job, so this is the one site in the cluster where
//! relocation is forced for a second, independent reason.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use futures_util::stream::StreamExt;
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch, Mutex as TokioMutex};
use tokio_util::sync::CancellationToken;

use archimedes_lib::agent::events::RpcEvent;
use archimedes_lib::agent::harness::{
    FinishReason, InProcessDispatcher, Model, ModelCatalog, PromptTurn, Provider, ProviderError,
    ProviderEvent, RetryPolicy, SubagentDispatcher, SudoDeps, ToolCall,
};
use archimedes_lib::agent::subagent::SubagentSessionManager;
use archimedes_lib::agent::worker::client::{WorkerError, WorkerHandle, WorkerInboundEvent};
use archimedes_lib::agent::worker::manager::{WorkerFactory, WorkerManager};
use archimedes_lib::agent::worker::protocol::{DesktopConfig, StartEnv, StartMode};
use archimedes_lib::agent::{EventSink, PendingPermissions, TodoStore};
use archimedes_lib::config::{load_settings, AgentOverrideFields};
use archimedes_lib::test_support::ScratchDir;

/// The spawn-bound the crate fixture uses for waits that cover SPAWNING A REAL
/// PROCESS (verbatim from `loop/tests/support.rs`'s `SPAWN_MS` — the relocated
/// waits keep the exact value that was tuned for Windows Defender scanning every
/// spawned exe under CI contention).
const SPAWN_MS: u64 = 60_000;

/// A scripted `Provider` (the crate fixture's `ScriptedProvider` — canned
/// `ProviderEvent`s per `complete` call, out-of-range repeats the LAST script).
struct ScriptedProvider {
    calls: Arc<AtomicU32>,
    scripts: Vec<Option<Vec<ProviderEvent>>>,
}

impl ScriptedProvider {
    fn new(scripts: Vec<Option<Vec<ProviderEvent>>>) -> (Self, Arc<AtomicU32>) {
        let calls = Arc::new(AtomicU32::new(0));
        (
            Self {
                calls: calls.clone(),
                scripts,
            },
            calls,
        )
    }
}

#[async_trait::async_trait]
impl Provider for ScriptedProvider {
    async fn complete(
        &self,
        _req: &archimedes_lib::agent::harness::ModelRequest,
    ) -> Result<futures_util::stream::BoxStream<'static, ProviderEvent>, ProviderError> {
        let i = self.calls.fetch_add(1, Ordering::SeqCst) as usize;
        let entry = if i < self.scripts.len() {
            &self.scripts[i]
        } else {
            self.scripts.last().expect("at least one script")
        };
        match entry {
            Some(events) => Ok(futures_util::stream::iter(events.clone()).boxed()),
            None => futures_util::future::pending().await,
        }
    }
}

/// A `Model` for a given bare id (the crate fixture's `fake_model`).
fn fake_model(id: &str) -> Model {
    Model {
        id: id.to_string(),
        provider: "fake".to_string(),
        base_url: "http://fake".to_string(),
        api_key: "k".to_string(),
        context_window: 128000,
        cost_per_mtok_in: 0.0,
        cost_per_mtok_out: 0.0,
        supports_tools: true,
        supports_thinking: false,
        thinking_levels: Vec::new(),
        api: Some("openai-completions".to_string()),
    }
}

/// A text-only `PromptTurn` (the crate fixture's `text_prompt`).
fn text_prompt(text: &str) -> PromptTurn {
    PromptTurn {
        text: text.to_string(),
        images: Vec::new(),
    }
}

/// Await the first event matching `pred` (the crate fixture's `wait_for_event`).
async fn wait_for_event(
    rx: &mut mpsc::UnboundedReceiver<RpcEvent>,
    timeout_ms: u64,
    pred: impl Fn(&RpcEvent) -> bool,
) -> Result<RpcEvent, ()> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(());
        }
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(ev)) => {
                if pred(&ev) {
                    return Ok(ev);
                }
            }
            Ok(None) | Err(_) => return Err(()),
        }
    }
}

/// The `fake_worker` fixture factory. `CARGO_BIN_EXE_fake_worker` is the
/// compile-time path cargo hands an INTEGRATION target for a built bin — the
/// `tests/worker_stderr.rs` idiom, and the fix for the `.parent()` rooting trap
/// the crate copy carried (see the module docs).
struct FakeWorkerFactory;

impl WorkerFactory for FakeWorkerFactory {
    fn spawn(&self) -> Result<WorkerHandle, WorkerError> {
        WorkerHandle::spawn(&PathBuf::from(env!("CARGO_BIN_EXE_fake_worker")))
    }
}

/// A recording `EventSink` (the crate fixture's `RecordingSink` — the `TestSink`
/// captures only `session-update` and cannot see `subagent-session-started`).
#[derive(Clone)]
struct RecordingSink {
    events: Arc<StdMutex<Vec<(String, Value)>>>,
}

impl EventSink for RecordingSink {
    fn emit(&self, event: &str, payload: Value) {
        self.events
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push((event.to_string(), payload));
    }
}

/// The two scratch dirs the fixture mints, held as ONE guard so a caller that
/// binds only the space cannot drop the `Db`'s dir while the loop's store is
/// still open inside it. Declared so the `Db` dir drops FIRST (reverse order:
/// `db_dir` is the last field, so it drops first) — the SQLite file lives inside
/// it and Windows will not unlink an open handle.
struct FixtureDirs {
    space: ScratchDir,
    _db_dir: ScratchDir,
}

impl std::ops::Deref for FixtureDirs {
    type Target = std::path::Path;
    fn deref(&self) -> &std::path::Path {
        self.space.path()
    }
}

/// Build an `AgentLoop` with a `subagent` dispatcher + a MULTI-model catalog —
/// the desktop twin of `loop/tests/support.rs::build_loop_with_dispatcher`
/// (which stays in the crate for the nine tests that use the `MockDispatcher`
/// seam). Two differences, both forced by where the code now lives:
///
///   * the store is a real `SessionStore` over a temp `Db` rather than the
///     crate's `MemoryStore` double, because `test_support::MemoryStore` is
///     `#[cfg(test)]` inside `fulcrum-harness` and does not exist for a desktop
///     target (Step A.4). These five tests never read the store — the loop's
///     transcript is a side effect here — so the swap changes no assertion, and
///     the FK the `Db` needs is satisfied by `record_session`. The `Db`'s dir
///     rides back in [`FixtureDirs`] so it cannot outlive its own guard;
///   * the opener is the crate's `NoOpenRequester` (the S5a SEAM 2 parameter): a
///     fixture must never launch a real browser.
#[allow(clippy::too_many_arguments)]
fn build_loop_with_dispatcher(
    provider: Box<dyn Provider>,
    events: mpsc::UnboundedSender<RpcEvent>,
    turn_cancel: Arc<StdMutex<CancellationToken>>,
    settle_tx: watch::Sender<u64>,
    retry: RetryPolicy,
    sink: Arc<dyn EventSink>,
    subagent: Option<Arc<dyn SubagentDispatcher>>,
    models: Vec<Model>,
    agent_overrides: Option<&HashMap<String, AgentOverrideFields>>,
) -> (FixtureDirs, archimedes_lib::agent::harness::AgentLoop) {
    let space = ScratchDir::in_env_temp("harness-loop-test-", "dispatch");
    // The store's own scratch dir, guarded FIRST so it drops LAST (the `Db`'s
    // SQLite file lives inside it — the Windows-critical ordering).
    let db_dir = ScratchDir::in_env_temp("harness-loop-test-", "db");
    let db = Arc::new(archimedes_lib::storage::Db::open(&db_dir.join("t.db")).expect("a temp db"));
    db.record_session(&archimedes_lib::agent::SessionInfo {
        session_id: "s1".to_string(),
        cwd: PathBuf::from("/tmp/space"),
        capabilities: json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    })
    .expect("record_session");
    // Both guards travel back: a tuple drops in REVERSE declaration order, so
    // the returned `(space, loop_)` pair cannot drop the dir out from under a
    // store the loop still holds. The `Db` guard is attached to the loop's own
    // lifetime by parking it in the loop's `space_cwd` owner — see the
    // `_db_dir` binding the callers below keep alive through the loop.
    let store = Arc::new(archimedes_lib::agent::harness::SessionStore::new(db));
    let model = models.first().cloned().expect("at least one model");
    let catalog = ModelCatalog {
        models: models.clone(),
        default_model: None,
        compaction: Default::default(),
    };
    let (prompt_tx, prompt_rx) = mpsc::channel(8);
    let mut loop_ = archimedes_lib::agent::harness::AgentLoop::new(
        "s1".to_string(),
        space.to_path_buf(),
        model,
        provider,
        catalog,
        store,
        events,
        CancellationToken::new(),
        turn_cancel,
        settle_tx,
        prompt_tx,
        prompt_rx,
        Arc::new(TokioMutex::new(HashMap::new())) as PendingPermissions,
        Arc::new(TokioMutex::new(HashMap::new())),
        None,
        sink,
        Arc::new(TodoStore::new()),
        subagent,
        SudoDeps::default(),
        retry,
        // (Fulcrum T3) No settings dir: the override layer arrives packaged.
        None,
        "t".to_string(),
        Arc::new(archimedes_lib::agent::mcp::NoOpenRequester),
    );
    // The PACKAGED ADR 0066 layer the parent loop hands to `resolve_launch` on
    // every dispatch (`loop/tools.rs` reads `self.packaged_agent_overrides`).
    // `None` = the layer that cannot speak; `Some(map)` is the override case.
    if let Some(map) = agent_overrides {
        loop_.set_desktop_config(None, None, Some(map.clone()), Vec::new(), HashMap::new());
    }
    (
        FixtureDirs {
            space,
            _db_dir: db_dir,
        },
        loop_,
    )
}

/// A `WorkerManager` with the loop's parent session (`"s1"` — the
/// `AgentLoop`'s `session_id`) `attach`ed (the ADR 0025 Task 5
/// re-plumb — the subagent runs in a `fake_worker` process): the
/// parent's `StartEnv` carries the given `models` catalog (the
/// `dispatch_subagent` flow resolves the child's `model` against it)
/// and the given `config_dir` (the settings' `subagentModels`
/// override is resolved loop-side; the `config_dir` is the
/// parent's). The `sink_for` lookup returns the given sink for the
/// parent (the `subagent-session-started` / `subagent-closed` UI
/// lifecycle events are delivered on the PARENT's sink).
async fn make_worker_manager(
    dead_bound: Duration,
    models: Vec<Model>,
    agent_overrides: Option<&HashMap<String, AgentOverrideFields>>,
    sink: Arc<dyn EventSink>,
) -> Arc<WorkerManager> {
    let factory: Arc<dyn WorkerFactory> = Arc::new(FakeWorkerFactory);
    // The `on_event` closure mirrors the router's `SinkFrame` re-emit
    // (the child's `SinkFrame`s — the `session_info` Start echo with
    // the `systemPrompt` / `trusted` envelope fields — land on the
    // test's sink; the `RpcEvent` stream is a no-op here).
    let on_event_sink = sink.clone();
    let wm = WorkerManager::new(
        factory,
        Arc::new(|_id: String, _code: Option<i32>, _pid: Option<u32>| {}),
        Arc::new(
            move |_id: String, is_subagent: bool, evt: WorkerInboundEvent| {
                if is_subagent {
                    if let WorkerInboundEvent::SinkFrame { event, payload } = &evt {
                        on_event_sink.emit(event, payload.clone());
                    }
                }
            },
        ),
        Arc::new(move |id: &str| (id == "s1").then(|| sink.clone())),
    )
    .with_dead_bound(dead_bound);
    let wm = Arc::new(wm);
    let env = StartEnv::from_parts(
        "s1".to_string(),
        "/tmp/space".to_string(),
        StartMode::Fresh,
        None,
        models[0].clone(),
        ModelCatalog {
            models,
            default_model: None,
            compaction: Default::default(),
        },
        None,
        true,
        None,
        // (Fulcrum T3) `config_dir` stays a plain string on the envelope (T3
        // does not delete the field), but NOTHING reads it any more — this
        // fixture's child is `fake_worker`, which performs no filesystem I/O.
        "/tmp".to_string(),
        true,
        None,
        // (issue #101) `from_parts`' new trailing arg (parent fixture: no block).
        None,
    );
    // (Fulcrum T3) The packaged desktop config on the PARENT's stored env.
    // `None` here leaves the env on its inert five (the layer that cannot
    // speak); `Some(map)` is what the Supervisor ships, and it is what each
    // child's five are read off (`DesktopConfig::from_env(&parent_env)`) — the
    // ADR 0023 next-dispatch hop.
    let env = match agent_overrides {
        Some(map) => env.with_desktop_config(DesktopConfig {
            agent_overrides: map.clone(),
            ..DesktopConfig::default()
        }),
        None => env,
    };
    wm.attach("s1", &env)
        .await
        .expect("the parent attach completes");
    wm
}

/// A `SubagentSessionManager` on a `WorkerManager` (the ADR 0025
/// Task 5 re-plumb — the `InProcessDispatcher`'s manager): the parent
/// `"s1"` is `attach`ed with the given `models` catalog (the
/// `dispatch_subagent` flow resolves the child's `model` against it).
async fn make_subagent_manager(
    dead_bound: Duration,
    models: Vec<Model>,
    agent_overrides: Option<&HashMap<String, AgentOverrideFields>>,
    sink: Arc<dyn EventSink>,
) -> Arc<SubagentSessionManager> {
    let wm = make_worker_manager(dead_bound, models, agent_overrides, sink).await;
    let manager = Arc::new(SubagentSessionManager::new());
    manager.set_dispatcher(wm);
    manager
}

/// (ADR 0023 thinking-order regression) the `:<level>` suffix of the
/// resolved model key beats the frontmatter's `thinking` (the
/// doc-correct order — explicit > suffix > frontmatter; the OLD code
/// produced the frontmatter's `"low"` here). The ADR 0025 Task 5
/// re-plumb: the subagent runs in a `fake_worker` process (the
/// `WorkerManager`'s `dispatch_subagent` flow) — the
/// `subagent-session-started` frame carries the RESOLVED model +
/// thinking, and the `subagent` tool result is the child's captured
/// final text (the `fake_worker`'s canned `"canned answer"`).
#[tokio::test]
async fn a_native_subagent_with_a_suffix_model_key_uses_the_suffix_thinking() {
    let (events_tx, mut events_rx) = mpsc::unbounded_channel();
    let (provider, _calls) = ScriptedProvider::new(vec![
        Some(vec![
            ProviderEvent::ToolCall(ToolCall {
                id: "t1".to_string(),
                name: "subagent".to_string(),
                arguments: json!({ "task": "recon the auth code", "agentName": "scout" }),
            }),
            ProviderEvent::Done(FinishReason::ToolCalls),
        ]),
        Some(vec![
            ProviderEvent::TextDelta("done".to_string()),
            ProviderEvent::Done(FinishReason::Stop),
        ]),
    ]);
    // A TWO-model catalog: `fake/m1` (the parent) + `fake/m2` (the
    // frontmatter target — IN the catalog, so it is NOT stale).
    let models = vec![fake_model("m1"), fake_model("m2")];
    let sink_events = Arc::new(StdMutex::new(Vec::<(String, Value)>::new()));
    let sink: Arc<dyn EventSink> = Arc::new(RecordingSink {
        events: sink_events.clone(),
    });
    let manager =
        make_subagent_manager(Duration::from_secs(30), models.clone(), None, sink.clone()).await;
    let (_space, mut loop_) = build_loop_with_dispatcher(
        Box::new(provider),
        events_tx,
        Arc::new(StdMutex::new(CancellationToken::new())),
        watch::channel(0u64).0,
        RetryPolicy::new_with(5, Duration::from_millis(1)),
        sink,
        Some(Arc::new(InProcessDispatcher::new(manager)) as Arc<dyn SubagentDispatcher>),
        models,
        None,
    );
    // The Agent definition: `model: fake/m2:high` (IN the catalog —
    // the `:<level>` suffix is stripped for the resolvability check)
    // + `thinking: low` (the LAST rung — the suffix beats it).
    let agent_file = loop_.space_cwd.join(".agents/agents/scout.md");
    if let Some(parent) = agent_file.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(
        &agent_file,
        "---\nname: scout\ndescription: Fast recon.\nmodel: fake/m2:high\nthinking: low\n---\nYou are a scout.\n",
    )
    .unwrap();
    loop_.handle_prompt(&text_prompt("go")).await;
    // The `subagent` tool result: the child's captured final text
    // (the `fake_worker`'s canned `"canned answer"` — the
    // `SubagentCapture` over the child's `SinkFrame`
    // `agent_message_chunk` stream).
    let end = wait_for_event(
        &mut events_rx,
        SPAWN_MS,
        |e| matches!(e, RpcEvent::tool_execution_end { tool_call_id, .. } if tool_call_id == "t1"),
    )
    .await
    .expect("the `subagent`'s tool_execution_end");
    let RpcEvent::tool_execution_end {
        result, is_error, ..
    } = end
    else {
        unreachable!()
    };
    assert!(!is_error, "the child completed");
    assert_eq!(
        result["content"][0]["text"], "canned answer",
        "the tool result is the child's captured final text"
    );
    // The parent turn settled (bounded — the `ScriptedProvider`
    // settles it; the child ran to completion inside the dispatch).
    wait_for_event(&mut events_rx, SPAWN_MS, |e| {
        matches!(e, RpcEvent::agent_settled)
    })
    .await
    .expect("the parent turn settled");
    // The `subagent-session-started` frame: the suffix's `high`
    // beats the frontmatter's `low` (the doc-correct order), and
    // the model is the suffix-STRIPPED key.
    let events = sink_events
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let started = events
        .iter()
        .find(|(name, _)| name == "subagent-session-started")
        .expect("the `subagent-session-started` frame was emitted");
    assert_eq!(
        started.1["model"], "fake/m2",
        "the suffix is stripped for the model resolution"
    );
    assert_eq!(
        started.1["thinkingLevel"], "high",
        "the suffix beats the frontmatter's `thinking` (the order fix)"
    );
}

/// (ADR 0023) end-to-end: a settings `subagentModels` override beats
/// the frontmatter `model` (the child runs the override), and the
/// frontmatter's `thinking` STILL applies (the override only
/// replaces the model). The ADR 0025 Task 5 re-plumb: the subagent
/// runs in a `fake_worker` process — the `subagent-session-started`
/// frame carries the RESOLVED model + thinking + tools, and the
/// `subagent` tool result is the child's captured final text (the
/// `fake_worker`'s canned `"canned answer"`).
///
/// (Fulcrum T3 + ADR 0066) The document is still written in the RETIRED
/// `subagentModels` spelling and still folded through the real
/// `load_settings` — because the fold is the SUPERVISOR's job, and the
/// envelope must carry the POST-FOLD map. What changed is only WHERE the fold's
/// output goes: it used to be re-read by `resolve_launch` from
/// `config_dir/settings.json` per dispatch; now the Supervisor packages it and
/// the loop reads its `packaged_agent_overrides`. Hand-building the map here
/// would let this test pass while the fold itself broke, so the legacy spelling
/// is deliberately kept as the fixture's input.
#[tokio::test]
async fn a_native_subagent_with_a_settings_override_runs_the_override_model() {
    let (events_tx, mut events_rx) = mpsc::unbounded_channel();
    let (provider, _calls) = ScriptedProvider::new(vec![
        Some(vec![
            ProviderEvent::ToolCall(ToolCall {
                id: "t1".to_string(),
                name: "subagent".to_string(),
                arguments: json!({ "task": "recon the auth code", "agentName": "scout" }),
            }),
            ProviderEvent::Done(FinishReason::ToolCalls),
        ]),
        Some(vec![
            ProviderEvent::TextDelta("done".to_string()),
            ProviderEvent::Done(FinishReason::Stop),
        ]),
    ]);
    // A THREE-model catalog: `fake/m1` (the parent) + `fake/m2` (the
    // frontmatter target) + `fake/m3` (the override target — IN the
    // catalog, so it is NOT stale).
    let models = vec![fake_model("m1"), fake_model("m2"), fake_model("m3")];
    // The settings document, in the LEGACY spelling, parsed and folded exactly
    // as the Supervisor does it: `load_settings` moves `subagentModels` into
    // `agent_overrides` and CLEARS the legacy map (ADR 0066). The scratch dir
    // exists only to feed that one read — the loop and the child never see it.
    let config_dir = ScratchDir::in_env_temp("harness-agent-def-e2e-cfg-", "override");
    std::fs::write(
        config_dir.join("settings.json"),
        r#"{ "subagentModels": { "scout": "fake/m3" } }"#,
    )
    .unwrap();
    let folded = load_settings(&config_dir);
    assert_eq!(
        folded
            .agent_overrides
            .get("scout")
            .and_then(|e| e.model.as_deref()),
        Some("fake/m3"),
        "the fixture's premise: the fold produced the override"
    );
    assert!(
        folded.subagent_models.is_empty(),
        "ADR 0066: the legacy map is CLEARED, so the Worker can never see it"
    );
    // ADR 0067: the folded entry's `tools` is ABSENT (the legacy spelling
    // carried only a model) — never `Some(vec![])`.
    assert_eq!(
        folded
            .agent_overrides
            .get("scout")
            .and_then(|e| e.tools.as_ref()),
        None,
        "an absent tool list stays absent through the fold"
    );
    let overrides = folded.agent_overrides.clone();
    let sink_events = Arc::new(StdMutex::new(Vec::<(String, Value)>::new()));
    let sink: Arc<dyn EventSink> = Arc::new(RecordingSink {
        events: sink_events.clone(),
    });
    let manager = make_subagent_manager(
        Duration::from_secs(30),
        models.clone(),
        Some(&overrides),
        sink.clone(),
    )
    .await;
    let (_space, mut loop_) = build_loop_with_dispatcher(
        Box::new(provider),
        events_tx,
        Arc::new(StdMutex::new(CancellationToken::new())),
        watch::channel(0u64).0,
        RetryPolicy::new_with(5, Duration::from_millis(1)),
        sink,
        Some(Arc::new(InProcessDispatcher::new(manager)) as Arc<dyn SubagentDispatcher>),
        models,
        Some(&overrides),
    );
    // The Agent definition: `model: fake/m2` (IN the catalog — NOT
    // stale) + `thinking: low` (the override replaces ONLY the
    // model — the thinking still comes from the file).
    let agent_file = loop_.space_cwd.join(".agents/agents/scout.md");
    if let Some(parent) = agent_file.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(
        &agent_file,
        "---\nname: scout\ndescription: Fast recon.\nmodel: fake/m2\nthinking: low\ntools: [read]\n---\nYou are a scout.\n",
    )
    .unwrap();
    loop_.handle_prompt(&text_prompt("go")).await;
    // The `subagent` tool result: the child's captured final text
    // (the `fake_worker`'s canned `"canned answer"`).
    let end = wait_for_event(
        &mut events_rx,
        SPAWN_MS,
        |e| matches!(e, RpcEvent::tool_execution_end { tool_call_id, .. } if tool_call_id == "t1"),
    )
    .await
    .expect("the `subagent`'s tool_execution_end");
    let RpcEvent::tool_execution_end {
        result, is_error, ..
    } = end
    else {
        unreachable!()
    };
    assert!(!is_error, "the child completed");
    assert_eq!(
        result["content"][0]["text"], "canned answer",
        "the tool result is the child's captured final text"
    );
    // The parent turn settled (bounded — the `ScriptedProvider`
    // settles it; the child ran to completion inside the dispatch).
    wait_for_event(&mut events_rx, SPAWN_MS, |e| {
        matches!(e, RpcEvent::agent_settled)
    })
    .await
    .expect("the parent turn settled");
    // The `subagent-session-started` frame: the override beats the
    // frontmatter's model, the frontmatter's `thinking` still
    // applies, and the tools are the frontmatter's allowlist.
    let events = sink_events
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let started = events
        .iter()
        .find(|(name, _)| name == "subagent-session-started")
        .expect("the `subagent-session-started` frame was emitted");
    assert_eq!(
        started.1["model"], "fake/m3",
        "the settings override beats the frontmatter model"
    );
    assert_eq!(
        started.1["thinkingLevel"], "low",
        "the frontmatter's `thinking` still applies (the override only replaces the model)"
    );
    assert_eq!(
        started.1["enabledTools"],
        json!(["read"]),
        "the child's tools are the frontmatter's allowlist"
    );
}

/// (ADR 0020) End-to-end: a native subagent dispatched with an
/// `agentName` matching a discovered definition runs the FRONTMATTER
/// config (the `dispatch_subagent` → `resolve_launch` layering — the
/// child's `subagent-session-started` payload carries the
/// frontmatter's `model` + `tools`, and the child's `Start` envelope
/// (the `fake_worker`'s `session_info` echo) carries the frontmatter
/// body as the `systemPrompt` + exactly the frontmatter's tools).
/// The ADR 0025 Task 5 re-plumb: the subagent runs in a `fake_worker`
/// process — the `subagent` tool result is the child's captured
/// final text (the `fake_worker`'s canned `"canned answer"`).
///
/// No `env_lock()` here (intentional): `resolve_launch` reads `HOME`
/// (via `discover_agents` → `user_roots`), concurrently with the
/// `HOME`-mutating tests — but the isolation is safe by construction:
/// (1) the space-level roots are scanned FIRST (first-wins dedupe),
/// so a user-level `scout` file can never shadow the space-level
/// `scout` written below; (2) the mutators' scratch homes contain no
/// agent files. If this test ever asserts on a USER-level definition,
/// it must take `env_lock()` (and set `HOME`) first.
#[tokio::test]
async fn a_native_subagent_with_a_matching_agent_name_runs_the_frontmatter_config() {
    let (events_tx, mut events_rx) = mpsc::unbounded_channel();
    let (provider, _calls) = ScriptedProvider::new(vec![
        Some(vec![
            ProviderEvent::ToolCall(ToolCall {
                id: "t1".to_string(),
                name: "subagent".to_string(),
                arguments: json!({ "task": "recon the auth code", "agentName": "scout" }),
            }),
            ProviderEvent::Done(FinishReason::ToolCalls),
        ]),
        Some(vec![
            ProviderEvent::TextDelta("done".to_string()),
            ProviderEvent::Done(FinishReason::Stop),
        ]),
    ]);
    // A TWO-model catalog: `fake/m1` (the parent) + `fake/m2` (the
    // frontmatter target — IN the catalog, so it is NOT stale).
    let models = vec![fake_model("m1"), fake_model("m2")];
    let sink_events = Arc::new(StdMutex::new(Vec::<(String, Value)>::new()));
    let sink: Arc<dyn EventSink> = Arc::new(RecordingSink {
        events: sink_events.clone(),
    });
    let manager =
        make_subagent_manager(Duration::from_secs(30), models.clone(), None, sink.clone()).await;
    let (_space, mut loop_) = build_loop_with_dispatcher(
        Box::new(provider),
        events_tx,
        Arc::new(StdMutex::new(CancellationToken::new())),
        watch::channel(0u64).0,
        RetryPolicy::new_with(5, Duration::from_millis(1)),
        sink,
        Some(Arc::new(InProcessDispatcher::new(manager)) as Arc<dyn SubagentDispatcher>),
        models,
        None,
    );
    // The Agent definition (the loop's `space_cwd` is the Space root
    // — the frontmatter's `model` is IN the catalog, so it is NOT
    // stale).
    let agent_file = loop_.space_cwd.join(".agents/agents/scout.md");
    if let Some(parent) = agent_file.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(
        &agent_file,
        "---\nname: scout\ndescription: Fast recon.\nmodel: fake/m2\nthinking: low\ntools: [read]\n---\nYou are a scout.\n",
    )
    .unwrap();
    loop_.handle_prompt(&text_prompt("go")).await;
    // The parent turn settled (bounded — the `ScriptedProvider`
    // settles it; the child ran to completion inside the dispatch).
    wait_for_event(&mut events_rx, SPAWN_MS, |e| {
        matches!(e, RpcEvent::agent_settled)
    })
    .await
    .expect("the parent turn settled");
    // The `subagent-session-started` frame (the `TestSink` cannot
    // see it — the `RecordingSink` records EVERY event): the child's
    // RESOLVED model / tools / thinking carry the frontmatter.
    let events = sink_events
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let started = events
        .iter()
        .find(|(name, _)| name == "subagent-session-started")
        .expect("the `subagent-session-started` frame was emitted");
    assert_eq!(
        started.1["model"], "fake/m2",
        "the child runs the frontmatter's model (the catalog's `fake/m2`)"
    );
    assert_eq!(
        started.1["enabledTools"],
        json!(["read"]),
        "the child's tools are the frontmatter's allowlist"
    );
    assert_eq!(
        started.1["thinkingLevel"], "low",
        "the child's thinking level is the frontmatter's"
    );
    assert_eq!(
        started.1["nameResolution"], "matched",
        "a discovered definition reports MATCHED end to end"
    );
    // The child's `Start` envelope (the `fake_worker`'s `session_info`
    // echo — re-emitted on the parent's scope by the `on_event`
    // router): the frontmatter body is the `systemPrompt` (the
    // `build_child_system_message` output — the body + the todo
    // instructions), and the `enabledTools` is exactly the
    // frontmatter's.
    let child_info = events
        .iter()
        .find(|(name, payload)| {
            name == "session-update"
                && payload["update"]["sessionUpdate"] == "session_info"
                && payload["update"]["systemPrompt"].is_string()
        })
        .expect("the child's `session_info` Start echo was re-emitted");
    assert!(
        child_info.1["update"]["systemPrompt"]
            .as_str()
            .unwrap()
            .starts_with("You are a scout."),
        "the frontmatter body is the child's system message (the `build_child_system_message` output)"
    );
    assert_eq!(
        child_info.1["update"]["enabledTools"],
        json!(["read"]),
        "the child gets exactly the frontmatter's tool"
    );
}

/// (issue #47) The exact scenario: `subagent({ agentName: "reviewr" })` — a
/// typo in a CORRECTLY-spelled key, so T9's unknown-KEY checker cannot see it.
///
/// Two halves, and the first is the one that matters: the miss NEVER blocks.
/// The `subagent` tool result is still the child's real captured output with
/// `is_error == false`, and the parent turn settles — ADR 0020's deliberate
/// config-less dispatch, unchanged, and the same non-blocking doctrine as T9's
/// warning and ADR 0055's metrics. The second half is what this task adds: the
/// `subagent-session-started` payload says `unmatched` while still carrying the
/// name the model asked for, so the UI can stop presenting a confident label
/// for a child that loaded no persona, no tool allowlist and no model.
///
/// Runs the REAL `resolve_launch` → `dispatch_native` → `subagent_flow` path.
/// NO agent file is written at all, so the name can only miss.
///
/// No `env_lock()` (the neighbour's note applies verbatim): the space-level
/// roots are scanned first and this Space holds no agent file, and the
/// mutators' scratch homes hold none either — and nothing here asserts on a
/// USER-level definition.
#[tokio::test]
async fn a_subagent_named_after_no_definition_still_runs_and_says_so() {
    let (events_tx, mut events_rx) = mpsc::unbounded_channel();
    let (provider, _calls) = ScriptedProvider::new(vec![
        Some(vec![
            ProviderEvent::ToolCall(ToolCall {
                id: "t1".to_string(),
                name: "subagent".to_string(),
                arguments: json!({ "task": "recon the auth code", "agentName": "reviewr" }),
            }),
            ProviderEvent::Done(FinishReason::ToolCalls),
        ]),
        Some(vec![
            ProviderEvent::TextDelta("done".to_string()),
            ProviderEvent::Done(FinishReason::Stop),
        ]),
    ]);
    let models = vec![fake_model("m1")];
    let sink_events = Arc::new(StdMutex::new(Vec::<(String, Value)>::new()));
    let sink: Arc<dyn EventSink> = Arc::new(RecordingSink {
        events: sink_events.clone(),
    });
    let manager =
        make_subagent_manager(Duration::from_secs(30), models.clone(), None, sink.clone()).await;
    let (_space, mut loop_) = build_loop_with_dispatcher(
        Box::new(provider),
        events_tx,
        Arc::new(StdMutex::new(CancellationToken::new())),
        watch::channel(0u64).0,
        RetryPolicy::new_with(5, Duration::from_millis(1)),
        sink,
        Some(Arc::new(InProcessDispatcher::new(manager)) as Arc<dyn SubagentDispatcher>),
        models,
        None,
    );
    // NO agent file: `"reviewr"` can only miss.
    loop_.handle_prompt(&text_prompt("go")).await;
    // 1. NON-BLOCKING: the tool result is the child's real output, not an error.
    let end = wait_for_event(
        &mut events_rx,
        SPAWN_MS,
        |e| matches!(e, RpcEvent::tool_execution_end { tool_call_id, .. } if tool_call_id == "t1"),
    )
    .await
    .expect("the `subagent`'s tool_execution_end");
    let RpcEvent::tool_execution_end {
        result, is_error, ..
    } = end
    else {
        unreachable!()
    };
    assert!(
        !is_error,
        "a resolve miss never fails the dispatch — got {result}"
    );
    assert_eq!(
        result["content"][0]["text"], "canned answer",
        "the tool result is the child's captured final text (the child RAN)"
    );
    // 2. The parent turn settled.
    wait_for_event(&mut events_rx, SPAWN_MS, |e| {
        matches!(e, RpcEvent::agent_settled)
    })
    .await
    .expect("the parent turn settled");
    // 3. The report: `unmatched`, and the name is still there (additive).
    let events = sink_events
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let started = events
        .iter()
        .find(|(name, _)| name == "subagent-session-started")
        .expect("the `subagent-session-started` frame was emitted");
    assert_eq!(
        started.1["nameResolution"], "unmatched",
        "a name that matched no definition is visible on the payload"
    );
    assert_eq!(
        started.1["agentName"], "reviewr",
        "the marker never replaces the label — the row keeps the name"
    );
}

/// (issue #47 follow-up) A PADDED `agentName` puts the TRIMMED name on the
/// payload. `resolve_launch` trims before it selects, so `"  scout  "` is a
/// genuine `Matched` — but the label travelled down a separate path, so the
/// wire (and therefore the payload) carried the RAW string while the marker
/// described the trimmed one: the UI printed `"  scout  "` and its row and its
/// badge were about two different names.
///
/// A PAYLOAD-level pin, deliberately not a resolver-level one:
/// `resolve_launch_a_blank_name_is_no_name_and_a_padded_name_is_a_match`
/// already proves the padded name MATCHES, and that test stays green with the
/// label bug in place — nothing below `dispatch_subagent` sees the difference
/// except this emit. Runs the same real path as the two neighbours above
/// (`resolve_launch` → `dispatch_native` → `subagent_flow`).
///
/// No `env_lock()` (both neighbours' note applies verbatim): the space-level
/// roots are scanned first, so a user-level `scout` can never shadow the
/// space-level one written below, and nothing here asserts on a USER-level
/// definition.
#[tokio::test]
async fn a_padded_agent_name_reaches_the_payload_trimmed() {
    let (events_tx, mut events_rx) = mpsc::unbounded_channel();
    let (provider, _calls) = ScriptedProvider::new(vec![
        Some(vec![
            ProviderEvent::ToolCall(ToolCall {
                id: "t1".to_string(),
                name: "subagent".to_string(),
                // The padding is the whole test: a model that emitted the name
                // with surrounding space (a copy out of a prose list) is the
                // realistic producer of this input.
                arguments: json!({ "task": "recon the auth code", "agentName": "  scout  " }),
            }),
            ProviderEvent::Done(FinishReason::ToolCalls),
        ]),
        Some(vec![
            ProviderEvent::TextDelta("done".to_string()),
            ProviderEvent::Done(FinishReason::Stop),
        ]),
    ]);
    let models = vec![fake_model("m1"), fake_model("m2")];
    let sink_events = Arc::new(StdMutex::new(Vec::<(String, Value)>::new()));
    let sink: Arc<dyn EventSink> = Arc::new(RecordingSink {
        events: sink_events.clone(),
    });
    let manager =
        make_subagent_manager(Duration::from_secs(30), models.clone(), None, sink.clone()).await;
    let (_space, mut loop_) = build_loop_with_dispatcher(
        Box::new(provider),
        events_tx,
        Arc::new(StdMutex::new(CancellationToken::new())),
        watch::channel(0u64).0,
        RetryPolicy::new_with(5, Duration::from_millis(1)),
        sink,
        Some(Arc::new(InProcessDispatcher::new(manager)) as Arc<dyn SubagentDispatcher>),
        models,
        None,
    );
    let agent_file = loop_.space_cwd.join(".agents/agents/scout.md");
    if let Some(parent) = agent_file.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(
        &agent_file,
        "---\nname: scout\ndescription: Fast recon.\nmodel: fake/m2\nthinking: low\ntools: [read]\n---\nYou are a scout.\n",
    )
    .unwrap();
    loop_.handle_prompt(&text_prompt("go")).await;
    wait_for_event(&mut events_rx, SPAWN_MS, |e| {
        matches!(e, RpcEvent::agent_settled)
    })
    .await
    .expect("the parent turn settled");
    let events = sink_events
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let started = events
        .iter()
        .find(|(name, _)| name == "subagent-session-started")
        .expect("the `subagent-session-started` frame was emitted");
    // THE fix: the label the resolver actually selected by.
    assert_eq!(
        started.1["agentName"], "scout",
        "the payload carries the TRIMMED name — the marker and the label must \
         describe one string, got {:?}",
        started.1["agentName"]
    );
    // And the trim did not COST the dispatch anything: it still matched, and it
    // still ran the frontmatter (so this is not the `Unmatched` path in a
    // different costume).
    assert_eq!(
        started.1["nameResolution"], "matched",
        "a padded real name is still MATCHED"
    );
    assert_eq!(
        started.1["model"], "fake/m2",
        "the padded name still resolved the frontmatter's model"
    );
}
