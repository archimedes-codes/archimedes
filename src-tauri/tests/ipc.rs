//! The headless command-surface test (ADR 0025 Task 4): the Tauri command
//! surface driven through the `tauri::test` mock runtime + the
//! `setup_dirs` seam (the injectable `WorkerFactory` — the `fake_worker`
//! fixture; the `test_support` pattern).
//!
//! The UI contract is the SINK frames: the `SinkFrame`s are re-emitted
//! VERBATIM on the Tauri sink (the frontend is unchanged); the raw
//! `RpcEvent` stream is bookkeeping-only (NOT forwarded — a forward would
//! DOUBLE-DELIVER every `session-update`); the store frames are persisted
//! to `messages` / `native_messages` (the `TranscriptPersister`).
//!
//! THE GATE STORY, recorded here so the next reader finds it at the gate
//! itself instead of re-litigating it: a `#![cfg(target_os = "linux")]`
//! sits below (added in `5d87ecf` as an interim) because the first CI runs
//! that ever reached this binary on the other platforms crashed BEFORE any
//! assertion of ours ran — Windows at LOAD time with `0xc0000139
//! STATUS_ENTRYPOINT_NOT_FOUND`, macOS `SIGSEGV` after two tests passed.
//! Both were environmental/upstream, not assertion failures, and both have
//! real fixes — see `docs/research/tauri-mock-runtime-test-crashes.md` for
//! the full evidence. One fix has landed, one hasn't:
//!
//! * Windows — FIXED HERE, in the build, not in this file: the
//!   Common-Controls-v6 application manifest only ever reached the app binary
//!   (`tauri-winres` → `embed_resource::compile()` prints
//!   `cargo:rustc-link-arg-bins`, which is `[[bin]]`-scoped), so this test
//!   binary imported `comctl32!TaskDialogIndirect` against System32 v5.82 and
//!   the loader refused to start it (upstream tauri#13419). `build.rs` now
//!   takes the manifest away from tauri-winres
//!   (`WindowsAttributes::new_without_app_manifest()`) and re-emits it with
//!   the UNSCOPED `cargo:rustc-link-arg=/MANIFEST:EMBED` +
//!   `/MANIFESTINPUT:windows-app-manifest.xml` (+`/WX`) — the
//!   lucasfernog-blessed workaround in tauri#13419, confirmed in #13948 — so
//!   every target this package links (tests, benches, examples, cdylib)
//!   carries the manifest. Nothing about the shipped app changes.
//!
//! * macOS — NOT fixed yet, and THAT is why the Linux gate still sits
//!   below: the old layout builds the mock app on the libtest worker while
//!   pumping `app.run()` on a spawned thread and drives IPC from a
//!   `spawn_blocking` thread, but `MockRuntime`'s `RuntimeContext` is
//!   `unsafe impl Send + Sync` only on the promise that one thread touches
//!   it — two threads borrowing the same non-atomic `RefCell` is the
//!   SIGSEGV (evidence: `docs/research/tauri-mock-runtime-test-crashes.md`).
//!   The harness rewrite (build + run + IPC on ONE thread per test) re-opens
//!   this file by deleting the gate; the Windows half of the crash is
//!   already fixed above.
//!
//! Everything this file pins (command dispatch through the real ACL-free
//! custom-command path, verbatim sink re-emission, no double-delivery, store
//! persistence) is platform-neutral code.

// ENVIRONMENTAL GATE — delete when the one-thread harness lands (see the
// macOS bullet in the header). The Windows half of the original crash is
// fixed in `build.rs`, so macOS is the only platform still excluded.
#![cfg(target_os = "linux")]

use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::Listener;
use tauri::Manager;

use archimedes_lib::agent::worker::client::{WorkerHandle, WorkerInboundEvent};
use archimedes_lib::agent::worker::manager::{WorkerFactory, WorkerManager};
use archimedes_lib::agent::SessionInfo;
use archimedes_lib::setup_dirs_with_factory;
use archimedes_lib::storage::Db;

/// The `fake_worker` fixture factory (the `WorkerFactory` seam —
/// `cargo test` builds the bin targets; the fixture speaks the Worker
/// protocol: the canned event + store-frame + `SinkFrame` stream, the
/// `__crash__` exit 137, the `__permission__` round-trip, the `__slow__`
/// 10 s settle, the `__interactive__` `interactive-event` frame, and the
/// `config` echo).
struct FixtureFactory;

impl WorkerFactory for FixtureFactory {
    fn spawn(&self) -> Result<WorkerHandle, archimedes_lib::agent::worker::client::WorkerError> {
        WorkerHandle::spawn(&fixture_path())
    }
}

/// The `fake_worker` fixture path (`CARGO_BIN_EXE_fake_worker` — the compile-time
/// path cargo gives an INTEGRATION target for a built bin; under the T4 root
/// `[workspace]` that resolves inside the repo-root `target/`).
fn fixture_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_BIN_EXE_fake_worker"))
}

/// A temp config + data dir pair (the `settings.json` home + the
/// `archimedes.db` home — the `setup_dirs` seam's dirs), OWNED (#96 task 06).
///
/// NOT `Clone` any more: `_base` is a `ScratchDir`, and a second owner would
/// `remove_dir_all` the same path twice. The `Clone` this replaces was how 11
/// dirs/run leaked — a struct that named dirs it did not own, so nothing was
/// obliged to delete them.
struct TestDirs {
    config_dir: std::path::PathBuf,
    app_data_dir: std::path::PathBuf,
    /// The base dir BOTH paths point into, plus the `space` cwd inside it.
    /// LAST field on purpose: struct fields drop in DECLARATION order, so the
    /// paths (and anything holding a handle inside the dir) die first.
    _base: archimedes_lib::test_support::ScratchDir,
}

impl TestDirs {
    fn new() -> Self {
        let base = archimedes_lib::test_support::ScratchDir::in_env_temp("ipc-test-", "scratch");
        // The `cwd` (the Space) — it must EXIST (the `spaces` table is
        // keyed by the canonical path). A subdir of the guard, so `Drop`
        // takes it.
        let cwd = base.join("space");
        std::fs::create_dir_all(&cwd).unwrap();
        Self {
            config_dir: base.to_path_buf(),
            app_data_dir: base.to_path_buf(),
            _base: base,
        }
    }

    /// The `cwd` (the Space — the `start_session` / `set_space_trusted`
    /// target).
    fn cwd(&self) -> std::path::PathBuf {
        self.config_dir.join("space")
    }
}

/// The Tauri app (the `tauri::test` mock runtime + the `setup_dirs` seam
/// with the `fake_worker` factory) + the webview + the `run` thread.
///
/// The mock runtime's `run` BLOCKS (its `Ready` event triggers the
/// `setup` — the managed state; the `WebviewWindow`'s `close` ends it —
/// the single window + webview share id 0, so the `CloseWindow` message
/// empties the window map → the `ExitRequested` → the loop breaks). The
/// `run` runs on a background thread; the test invokes commands on the
/// test thread (the `get_ipc_response` — the command runs on Tauri's
/// thread pool, independent of the `run` loop). `Drop` closes the
/// webview + joins the thread (a non-daemon thread would block the test
/// binary at exit).
struct TestApp {
    handle: tauri::AppHandle<tauri::test::MockRuntime>,
    webview: tauri::WebviewWindow<tauri::test::MockRuntime>,
    thread: Option<std::thread::JoinHandle<()>>,
}

fn build_app(dirs: &TestDirs) -> TestApp {
    // Taken BEFORE the `'static` `setup` closure moves — the guard is not
    // `Clone` and must not travel with the app; only the paths do.
    let config_dir = dirs.config_dir.clone();
    let app_data_dir = dirs.app_data_dir.clone();
    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![
            archimedes_lib::commands::sessions::start_session,
            archimedes_lib::commands::sessions::send_prompt,
            archimedes_lib::commands::sessions::close_session,
            archimedes_lib::commands::sessions::respond_permission,
            archimedes_lib::commands::sessions::respond_interactive_request,
            archimedes_lib::commands::sessions::resume_session,
            archimedes_lib::commands::sessions::set_session_config_option,
            archimedes_lib::commands::sessions::cancel_session,
            archimedes_lib::commands::sessions::get_stalled_info,
            archimedes_lib::commands::spaces::set_space_trusted,
            archimedes_lib::commands::spaces::reorder_spaces,
            archimedes_lib::commands::history::list_sessions,
            archimedes_lib::commands::history::session_recency,
            archimedes_lib::commands::history::reorder_sessions,
            archimedes_lib::commands::settings::list_models,
            archimedes_lib::commands::attention::attention_disarm,
        ])
        .setup(move |app| {
            setup_dirs_with_factory(
                app,
                config_dir.clone(),
                app_data_dir.clone(),
                Some(Arc::new(FixtureFactory)),
            )
        })
        .build(tauri::generate_context!())
        .expect("the app should build");
    let handle = app.handle().clone();
    let thread = std::thread::spawn(move || {
        app.run(|_h, _e| {});
    });
    // Wait for the `setup` to complete (the managed state — bounded, so a
    // missing setup is a test failure, not a hang). Tauri's `setup` also
    // creates the config's default window (the `main` webview — the
    // `tauri.conf.json` window) BEFORE the setup closure runs, so by the
    // time the state is managed it exists.
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while std::time::Instant::now() < deadline {
        if handle
            .try_state::<Arc<archimedes_lib::agent::SessionManager>>()
            .is_some()
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        handle
            .try_state::<Arc<archimedes_lib::agent::SessionManager>>()
            .is_some(),
        "the setup completed (the SessionManager is managed state)"
    );
    let webview = handle
        .get_webview_window("main")
        .expect("the config window exists after the setup");
    TestApp {
        handle,
        webview,
        thread: Some(thread),
    }
}

impl Drop for TestApp {
    fn drop(&mut self) {
        // Close the webview (the `CloseWindow` message empties the window
        // map → the `run` loop breaks) + join the thread.
        let _ = self.webview.close();
        let _ = self.thread.take().unwrap().join();
    }
}

/// Invoke a command (the `get_ipc_response` — the command's Ok payload as
/// a `Value`; the Err payload is the `Err` arm).
///
/// ASYNC + `spawn_blocking`: the `get_ipc_response` BLOCKS the calling
/// thread, and the `#[tokio::test]` runtime is SINGLE-THREADED (the
/// `tokio` features lack `rt-multi-thread`) — a direct call would starve
/// the `raw_json_server` task (the model discovery's target — the
/// `start_session`'s `effective_catalog` `GET /v1/models` would time out
/// → "no models available"). A `spawn_blocking` thread leaves the
/// worker free to poll the server task.
async fn invoke_raw(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    cmd: &str,
    body: Value,
) -> Result<Value, Value> {
    let webview = webview.clone();
    let cmd = cmd.to_string();
    tokio::task::spawn_blocking(move || {
        get_ipc_response(
            &webview,
            InvokeRequest {
                cmd,
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
    })
    .await
    .expect("the invoke task")
    .map(|b| b.deserialize::<Value>().expect("the payload is JSON"))
}

/// Invoke a command (the Ok arm — a `Value`; the Err arm is a test
/// failure with the error payload in the message).
async fn invoke_ok(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    cmd: &str,
    body: Value,
) -> Value {
    invoke_raw(webview, cmd, body)
        .await
        .unwrap_or_else(|e| panic!("the command `{cmd}` must succeed, got error: {e}"))
}

/// Deserialize a command payload (the Ok arm's `Value` → the typed
/// shape).
fn value_to<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).expect("the payload deserializes")
}

/// The event collector (the `listen` on the mock runtime — the
/// `TauriSink`'s `AppHandle::emit` delivers to the global listeners).
struct EventCollector {
    events: StdMutex<Vec<(String, Value)>>,
}

impl EventCollector {
    /// Register listeners for the given event names (the `listen` — the
    /// `TauriSink`'s `AppHandle::emit` delivers to the global listeners).
    fn new(app: &TestApp, names: &[&str]) -> Arc<Self> {
        let collector = Arc::new(Self {
            events: StdMutex::new(Vec::new()),
        });
        for name in names {
            let c = collector.clone();
            // The `listen` handler is `'static` — the event name is
            // OWNED (the `names` slice's `&str`s don't outlive this
            // function).
            let name_owned = name.to_string();
            let _ = app.handle.listen(name_owned.clone(), move |event| {
                let payload = serde_json::from_str::<Value>(event.payload()).unwrap_or(Value::Null);
                c.events
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .push((name_owned.clone(), payload));
            });
        }
        collector
    }

    /// All payloads for an event name (so far).
    fn find(&self, name: &str) -> Vec<Value> {
        self.events
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .filter(|(e, _)| e == name)
            .map(|(_, p)| p.clone())
            .collect()
    }

    /// Wait for an event (bounded — a missing frame is a test failure,
    /// not a hang).
    async fn wait_for(&self, name: &str, timeout: Duration) -> Option<Value> {
        let deadline = tokio::time::Instant::now() + timeout;
        while tokio::time::Instant::now() < deadline {
            if let Some(v) = self.find(name).into_iter().next() {
                return Some(v);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        None
    }
}

/// The app's managed `WorkerManager` (the registry view — the
/// `test_support` accessor: a `start_session` spawns a Worker —
/// `test_is_attached` / `test_session_count`).
fn worker_manager(app: &TestApp) -> Arc<WorkerManager> {
    archimedes_lib::test_support::worker_manager(&app.handle)
        .expect("the WorkerManager is managed state")
}

/// The app's managed `Db` (the `test_support` accessor — the
/// `TranscriptPersister`'s rows are asserted through it).
fn db(app: &TestApp) -> Arc<Db> {
    archimedes_lib::test_support::db(&app.handle).expect("the Db is managed state")
}

/// Seed the config dir with a user provider (a raw-JSON `GET /v1/models`
/// discovery server on loopback) + `defaultModel` — `start_session`'s model
/// resolution (the settings `default_model` rung > the catalog default >
/// the selectable set) resolves the composed key `tama/m1` (the
/// `fake_worker` never calls the LLM — the model is resolved, not used).
/// Returns the server task (kept alive for the test's duration — the
/// discovery is a fresh `GET` per `effective_catalog`).
async fn seed_default_model(dirs: &TestDirs) -> tokio::task::JoinHandle<()> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("the discovery listener binds");
    let addr = listener.local_addr().unwrap();
    let settings = json!({
        "providers": [
            { "id": "tama", "name": "tama", "baseUrl": format!("http://{addr}/v1"), "apiKey": "k", "api": "openai-completions" }
        ],
        "defaultModel": "tama/m/1",
        // ISOLATION, not a knob this suite exercises: naming defaults ON
        // (`session_naming_enabled` is `#[serde(default = "default_true")]`)
        // and titling is now nudged from the non-droppable Supervisor sites
        // (`send_prompt_with_images`, `close_session`), so this mounted mock
        // server would receive an UNEXPECTED chat-completion from tests that
        // only ever test the IPC surface. Naming has its own suite
        // (`session::naming`, a recording provider).
        "sessionNamingEnabled": false
    });
    std::fs::write(
        dirs.config_dir.join("settings.json"),
        serde_json::to_string(&settings).unwrap(),
    )
    .expect("settings.json writes");
    archimedes_lib::test_support::raw_json_server(listener, 200, r#"{"data":[{"id":"m/1"}]}"#, None)
        .await
}

/// (a) `start_session` spawns the `fake_worker` (the `WorkerManager`'s
/// registry); a `send_prompt` yields the canned `SinkFrame`s on the Tauri
/// sink (the UI contract) AND writes the `messages` / `native_messages`
/// rows (the store frames applied by the `TranscriptPersister`) AND the
/// raw `RpcEvent` stream is NOT forwarded to the Tauri sink (no
/// `session-update` duplication — the sink saw the `session-update`
/// `SinkFrame`s exactly as the `fake_worker` emitted them).
#[tokio::test]
async fn start_session_spawns_the_worker_and_send_prompt_re_emits_the_sink_frames() {
    let dirs = TestDirs::new();
    let _server = seed_default_model(&dirs).await;
    let app = build_app(&dirs);
    let webview = app.webview.clone();
    let collector = EventCollector::new(&app, &["session-update"]);

    // (a1) `start_session` → the Worker is attached (the `test_support`
    // accessor — the `WorkerManager`'s registry).
    let info: SessionInfo = value_to(
        invoke_ok(
            &webview,
            "start_session",
            json!({ "cwd": dirs.cwd().display().to_string() }),
        )
        .await,
    );
    let wm = worker_manager(&app);
    assert!(
        wm.test_is_attached(&info.session_id),
        "start_session spawned the session's Worker"
    );

    // (a2) `send_prompt` → the canned `SinkFrame`s on the Tauri sink +
    // the store frames persisted.
    let stop = invoke_ok(
        &webview,
        "send_prompt",
        json!({ "sessionId": info.session_id, "text": "hello" }),
    )
    .await;
    assert_eq!(
        stop,
        json!("end_turn"),
        "the turn settles (the agent_settled)"
    );
    // The raw `RpcEvent` stream is NOT forwarded: the `session-update`
    // `SinkFrame`s are re-emitted VERBATIM — the `fake_worker` emits
    // exactly ONE `session_info` frame (on `start`) + TWO
    // `agent_message_chunk` frames (on `prompt`); a raw-`RpcEvent`
    // forward would add `session-update` frames beyond these.
    let updates = collector.find("session-update");
    let chunks = updates
        .iter()
        .filter(|p| p["update"]["sessionUpdate"] == "agent_message_chunk")
        .count();
    assert_eq!(
        chunks, 2,
        "the two `agent_message_chunk` SinkFrames are re-emitted verbatim"
    );
    assert_eq!(
        updates.len(),
        3,
        "no `session-update` beyond the three SinkFrames (the raw RpcEvent is bookkeeping-only)"
    );
    // The store frames are persisted (the `TranscriptPersister` — the
    // `native_messages` / `messages` upserts). `load_native_messages`
    // returns the `content_json` strings (parsed for the `role` field).
    let d = db(&app);
    let native = d
        .load_native_messages(&info.session_id)
        .expect("the native_messages load");
    let roles: Vec<Value> = native
        .iter()
        .map(|c| serde_json::from_str(c).expect("the content_json parses"))
        .collect();
    assert!(
        roles.iter().any(|v| v["role"] == "user"),
        "the user transcript row is persisted"
    );
    assert!(
        roles.iter().any(|v| v["role"] == "assistant"),
        "the assistant transcript row is persisted"
    );
    let msgs = d.messages_for(&info.session_id).expect("the messages load");
    assert!(
        msgs.iter().any(|m| m.kind == "agent-text"),
        "the display row is persisted"
    );
}

/// (b) A `"__crash__"` prompt → the `session-stalled` event fires + the
/// in-flight `send_prompt` resolves (the composer-unlock assertion) + the
/// session resumes via `resume_session` (a fresh `fake_worker` attached).
#[tokio::test]
async fn a_crash_stalls_the_session_resolves_the_turn_and_resumes() {
    let dirs = TestDirs::new();
    let _server = seed_default_model(&dirs).await;
    let app = build_app(&dirs);
    let webview = app.webview.clone();
    let collector = EventCollector::new(&app, &["session-stalled"]);

    let info: SessionInfo = value_to(
        invoke_ok(
            &webview,
            "start_session",
            json!({ "cwd": dirs.cwd().display().to_string() }),
        )
        .await,
    );

    // The crash: the `__crash__` prompt → the Worker exits 137 → the
    // `on_crash` path (the `session-stalled` event + the in-flight
    // `send_prompt` resolution — the composer-unlock assertion).
    let stop = invoke_raw(
        &webview,
        "send_prompt",
        json!({ "sessionId": info.session_id, "text": "__crash__" }),
    )
    .await
    .unwrap_or_else(|e| {
        panic!(
            "the in-flight send_prompt must RESOLVE on a crash (the composer never stays locked), got error: {e}"
        )
    });
    assert_eq!(
        stop,
        json!("cancelled"),
        "the crash resolves the turn Cancelled"
    );
    // The `session-stalled` event fires (the frontend's banner).
    let stalled = collector
        .wait_for("session-stalled", Duration::from_secs(15))
        .await
        .expect("the session-stalled event fires");
    assert_eq!(stalled["sessionId"], info.session_id);
    assert!(
        stalled["at"].is_number(),
        "the stalled event carries the crash time"
    );
    // The `stalled_info` query (the `get_stalled_info` command).
    let stalled_info = invoke_ok(
        &webview,
        "get_stalled_info",
        json!({ "sessionId": info.session_id }),
    )
    .await;
    assert!(
        stalled_info["at"].is_number(),
        "the stalled info carries the crash time: {stalled_info}"
    );
    // The session is RESUMABLE (a fresh Worker + re-hydrate).
    let resumed: SessionInfo = value_to(
        invoke_ok(
            &webview,
            "resume_session",
            json!({ "sessionId": info.session_id, "cwd": dirs.cwd().display().to_string() }),
        )
        .await,
    );
    assert_eq!(resumed.session_id, info.session_id);
    let wm = worker_manager(&app);
    assert!(
        wm.test_is_attached(&info.session_id),
        "the resume attached a fresh Worker"
    );
}

/// (c) `respond_permission` relays to the `fake_worker` (the
/// `__permission__` flow completes — the in-flight `send_prompt` settles
/// on the post-response `agent_settled`) AND the `trust-space` outcome
/// writes `spaces.trusted = 1` (the Supervisor's persistence half — the
/// Worker's `StaticTrustSource` flip is covered by the Task-2 unit test,
/// so the assertion here is the `db` write only — minimal, non-redundant).
#[tokio::test]
async fn respond_permission_relays_to_the_worker_and_persists_the_trust_space() {
    let dirs = TestDirs::new();
    let _server = seed_default_model(&dirs).await;
    let app = build_app(&dirs);
    let webview = app.webview.clone();
    let collector = EventCollector::new(&app, &["permission-request"]);

    let info: SessionInfo = value_to(
        invoke_ok(
            &webview,
            "start_session",
            json!({ "cwd": dirs.cwd().display().to_string() }),
        )
        .await,
    );

    // The `__permission__` prompt: the `fake_worker` emits a
    // `PermissionRequest` (the router re-emits it as the
    // `permission-request` Tauri event) and BLOCKS until a
    // `PermissionResponse` — so the `send_prompt` runs in a task (the
    // `respond_permission` must land while it is in flight).
    let prompt_webview = webview.clone();
    let prompt_session = info.session_id.clone();
    let prompt = tokio::spawn(async move {
        invoke_raw(
            &prompt_webview,
            "send_prompt",
            json!({ "sessionId": prompt_session, "text": "__permission__" }),
        )
        .await
    });
    // The `permission-request` event arrives (the payload UNCHANGED —
    // the `requestId` / `options` verbatim).
    let req = collector
        .wait_for("permission-request", Duration::from_secs(15))
        .await
        .expect("the permission-request event fires");
    assert_eq!(req["requestId"], "p1", "the requestId rides verbatim");
    assert!(
        req["request"]["options"]
            .as_array()
            .unwrap()
            .iter()
            .any(|o| o["optionId"] == "trust-space"),
        "the options ride verbatim"
    );
    // The `respond_permission` command (the `trust-space` outcome):
    // relays the `PermissionResponse` to the Worker + persists
    // `spaces.trusted = 1` (the Supervisor's persistence half).
    invoke_ok(
        &webview,
        "respond_permission",
        json!({
            "sessionId": info.session_id,
            "requestId": "p1",
            "outcome": { "selected": { "option_id": "trust-space" } }
        }),
    )
    .await;
    // The round-trip completes: the `fake_worker`'s post-response stream
    // (`agent_settled`) settles the in-flight turn (a missed relay would
    // hang the turn forever).
    let stop = prompt
        .await
        .expect("the send_prompt task")
        .unwrap_or_else(|e| panic!("the send_prompt must settle after the relay, got error: {e}"));
    assert_eq!(
        stop,
        json!("end_turn"),
        "the round-trip completes (the response was relayed)"
    );
    // The `trust-space` outcome persists `spaces.trusted = 1`.
    let d = db(&app);
    assert!(
        d.space_trusted(&dirs.cwd())
            .expect("the space_trusted lookup"),
        "the trust-space outcome persists the spaces write"
    );
}

/// (d) A `SinkFrame` (an `interactive-event` todo payload) re-emits on the
/// Tauri sink with the same event name + payload VERBATIM.
#[tokio::test]
async fn an_interactive_event_sink_frame_re_emits_verbatim() {
    let dirs = TestDirs::new();
    let _server = seed_default_model(&dirs).await;
    let app = build_app(&dirs);
    let webview = app.webview.clone();
    let collector = EventCollector::new(&app, &["interactive-event"]);

    let info: SessionInfo = value_to(
        invoke_ok(
            &webview,
            "start_session",
            json!({ "cwd": dirs.cwd().display().to_string() }),
        )
        .await,
    );

    // The `__interactive__` prompt: the `fake_worker` emits an
    // `interactive-event` `SinkFrame` (a `todos_update` payload) +
    // `agent_settled`.
    let stop = invoke_ok(
        &webview,
        "send_prompt",
        json!({ "sessionId": info.session_id, "text": "__interactive__" }),
    )
    .await;
    assert_eq!(stop, json!("end_turn"), "the turn settles");
    // The `interactive-event` re-emits with the same event name + payload
    // VERBATIM (the `todos_update` shape — `store/interactive.ts`
    // consumes it unchanged).
    let events = collector
        .wait_for("interactive-event", Duration::from_secs(15))
        .await
        .map(|first| {
            let all = collector.find("interactive-event");
            (first, all.len())
        })
        .expect("the interactive-event SinkFrame re-emits");
    let (payload, count) = events;
    assert_eq!(count, 1, "the interactive-event re-emits exactly once");
    assert_eq!(
        payload["event"], "todos_update",
        "the payload rides verbatim (the event name)"
    );
    assert_eq!(
        payload["payload"]["todos"][0]["content"], "do the thing",
        "the payload rides verbatim (the todos)"
    );
}

/// (e) A clean `close_session` → `session-closed` (the `ClosedReason`
/// `User` payload) + the in-flight `send_prompt` resolves `Cancelled`
/// (the composer-unlock assertion).
#[tokio::test]
async fn a_clean_close_emits_session_closed_and_resolves_the_turn() {
    let dirs = TestDirs::new();
    let _server = seed_default_model(&dirs).await;
    let app = build_app(&dirs);
    let webview = app.webview.clone();
    let collector = EventCollector::new(&app, &["session-closed"]);

    let info: SessionInfo = value_to(
        invoke_ok(
            &webview,
            "start_session",
            json!({ "cwd": dirs.cwd().display().to_string() }),
        )
        .await,
    );

    // An in-flight turn (the `__slow__` prompt — the `fake_worker`
    // sleeps 10 s before settling — so the close wins the race).
    let prompt_webview = webview.clone();
    let prompt_session = info.session_id.clone();
    let prompt = tokio::spawn(async move {
        invoke_raw(
            &prompt_webview,
            "send_prompt",
            json!({ "sessionId": prompt_session, "text": "__slow__" }),
        )
        .await
    });
    // Let the `send_prompt` ATTACH the in-flight turn BEFORE the close
    // (the `close_session` must not remove the session first — that
    // would make the `send_prompt` an `unknown_session` miss; the
    // `__slow__` turn is in flight for 10 s, so a short settle window
    // is enough for the attach to land).
    tokio::time::sleep(Duration::from_millis(300)).await;
    // The clean close: `close_session` → the `detach` → the Worker's
    // exit (the `reap`'s `close` + grace + `kill` — the `fake_worker`
    // is mid-sleep, so the `kill` lands) → the router's EXPECTED-exit
    // handling.
    invoke_ok(
        &webview,
        "close_session",
        json!({ "sessionId": info.session_id }),
    )
    .await;
    // The `session-closed` event (the `ClosedReason` `User` payload — a
    // `close_session` is a `User` close).
    let closed = collector
        .wait_for("session-closed", Duration::from_secs(15))
        .await
        .expect("the session-closed event fires");
    assert_eq!(closed["reason"], "user", "a close_session is a User close");
    // The in-flight `send_prompt` resolves `Cancelled` (a close kills
    // the turn — the composer unlocks; it never stays locked forever).
    let stop = prompt
        .await
        .expect("the send_prompt task")
        .unwrap_or_else(|e| {
            panic!("the in-flight send_prompt must RESOLVE on a close, got error: {e}")
        });
    assert_eq!(
        stop,
        json!("cancelled"),
        "the close resolves the turn Cancelled"
    );
}

/// (f) `set_space_trusted` sends a `Config { trusted }` to the space's
/// running `fake_worker` (the mid-session trust toggle — the Worker's
/// `StaticTrustSource` flip) AND persists the `spaces` write.
#[tokio::test]
async fn set_space_trusted_pushes_a_config_to_the_running_workers() {
    let dirs = TestDirs::new();
    let _server = seed_default_model(&dirs).await;
    let app = build_app(&dirs);
    let webview = app.webview.clone();
    let collector = EventCollector::new(&app, &["config-ack"]);

    let info: SessionInfo = value_to(
        invoke_ok(
            &webview,
            "start_session",
            json!({ "cwd": dirs.cwd().display().to_string() }),
        )
        .await,
    );
    let _ = info; // the session's Worker is running in the space

    // The `set_space_trusted` command: the `spaces` write + the
    // `Config { trusted }` push to the running Worker in the affected
    // Space.
    invoke_ok(
        &webview,
        "set_space_trusted",
        json!({ "path": dirs.cwd().display().to_string(), "trusted": true }),
    )
    .await;
    // The `fake_worker` echoes the `config` frame (a `config-ack`
    // `SinkFrame` — the delivery observation point).
    let ack = collector
        .wait_for("config-ack", Duration::from_secs(15))
        .await
        .expect("the worker received the Config frame");
    assert_eq!(
        ack["trusted"], true,
        "the Config frame carries the trusted flag"
    );
    // The `spaces` write.
    let d = db(&app);
    assert!(
        d.space_trusted(&dirs.cwd())
            .expect("the space_trusted lookup"),
        "the set_space_trusted command persists the spaces write"
    );
}

/// (f) A `"__subagent__"` prompt → the Supervisor's `dispatch_subagent`
/// flow spawns a SECOND `fake_worker` (the subagent) → the child's
/// transcript persists as a HIDDEN `is_subagent = 1` `sessions` row
/// (the `TranscriptPersister`'s `ensure_session_row` — the child's
/// `sessionId` is the `subagent-session-started` payload's `sessionId`;
/// the `native_messages` FK holds on the child's id, NOT the parent's
/// delivery id — the `persist.rs` frame-`sid` fix).
#[tokio::test]
async fn a_subagent_transcript_persists_as_a_hidden_ephemeral_row() {
    let dirs = TestDirs::new();
    let _server = seed_default_model(&dirs).await;
    let app = build_app(&dirs);
    let webview = app.webview.clone();
    let collector = EventCollector::new(&app, &["subagent-session-started", "subagent-closed"]);

    // (f1) `start_session` (the parent — the `fake_worker`'s
    // `SubagentDispatch` frame re-targets the child's frames to the
    // parent's scope for the UI, but the child's transcript rows land
    // on the CHILD's id).
    let info: SessionInfo = value_to(
        invoke_ok(
            &webview,
            "start_session",
            json!({ "cwd": dirs.cwd().display().to_string() }),
        )
        .await,
    );

    // (f2) The `__subagent__` prompt: the `fake_worker` emits a
    // `SubagentDispatch` frame + `agent_settled` (the parent's turn
    // settles); the Supervisor's flow spawns the child `fake_worker`
    // (the child's task is the fixture's default — a canned turn +
    // store frames + `agent_settled`).
    let stop = invoke_ok(
        &webview,
        "send_prompt",
        json!({ "sessionId": info.session_id, "text": "__subagent__" }),
    )
    .await;
    assert_eq!(
        stop,
        json!("end_turn"),
        "the parent's turn settles (the `agent_settled` after the `SubagentDispatch`)"
    );

    // The child's `sessionId` (the `subagent-session-started` payload —
    // the pre-minted child id the flow `attach`ed).
    let started = collector
        .wait_for("subagent-session-started", Duration::from_secs(30))
        .await
        .expect("the `subagent-session-started` fired");
    let child_id = started["sessionId"]
        .as_str()
        .expect("the started event carries the child's sessionId")
        .to_string();
    assert!(!child_id.is_empty(), "the child's sessionId is a real id");
    assert_eq!(
        started["parentSessionId"], info.session_id,
        "the started event carries the parent's id"
    );

    // The child's turn completed (the `subagent-closed` — the drive's
    // settle + teardown). By this point the child's store frames have
    // been persisted (they land BEFORE the child's `agent_settled`).
    let closed = collector
        .wait_for("subagent-closed", Duration::from_secs(30))
        .await
        .expect("the `subagent-closed` fired");
    assert_eq!(
        closed["status"], "completed",
        "the child completed (the `fake_worker`'s canned turn) — got: {closed:?}"
    );
    assert_eq!(
        closed["sessionId"], child_id,
        "the closed event carries the same child id"
    );

    // The child's transcript persists as a HIDDEN `is_subagent = 1`
    // `sessions` row (the `ensure_session_row` — the `native_messages`
    // FK holds on the CHILD's id, not the parent's delivery id).
    let d = db(&app);
    let child_row = d
        .session(&child_id)
        .expect("the child's sessions row load")
        .expect("the child's ephemeral row exists (the `ensure_session_row`)");
    assert!(
        child_row.is_subagent,
        "the child's row is flagged `is_subagent`"
    );
    // The row is HIDDEN from `list_sessions` (the ephemeral row — the
    // user's session list is unchanged by the subagent's transcript).
    let all = d.list_sessions(true).expect("the sessions list");
    assert!(
        !all.iter().any(|r| r.id == child_id),
        "the child's row is hidden from list_sessions"
    );
    // The child's transcript rows (the `native_messages` — the
    // `ensure_session_row` created the FK row before the insert).
    let native = d
        .load_native_messages(&child_id)
        .expect("the child's native_messages load");
    assert!(
        !native.is_empty(),
        "the child's transcript rows are persisted (the `native_messages` FK held)"
    );

    // (f4) THE CHILD'S OWN MONEY (#105, Task 3): the child's row carries its
    // own figure. Delivered the way the PUMP delivers a child frame — under
    // the PARENT's delivery id with `is_subagent: true` and the child's id in
    // the payload's `sessionId` — through the app's REAL `WorkerHooks`
    // (`SessionWorkerHooks` → `SessionManager::route_event` → the persister).
    let hooks = worker_manager(&app).hooks().clone();
    hooks.on_event(
        &info.session_id,
        true,
        WorkerInboundEvent::SinkFrame {
            event: "interactive-event".to_string(),
            payload: json!({
                "sessionId": child_id,
                "seq": 0,
                "event": "cost_update",
                "payload": { "costUsd": 0.00001243, "source": "main" },
            }),
        },
    );
    assert_eq!(
        d.session_cost(&child_id).expect("the child cost read"),
        Some(0.00001243),
        "a child's own priced frame lands on the CHILD's row through the \
         real hooks (its stored figure matches its own card)"
    );
    assert_eq!(
        d.session_cost(&info.session_id)
            .expect("the parent cost read"),
        None,
        "the child's own money must NOT land on the delivery id's row — that id \
         is the PARENT's, and a parent-keyed snapshot frame carrying the child's \
         total would leave the parent reporting a child's spend as its own (and \
         the child's own row would then hold nothing)"
    );
}

// ── The stored cost on the wire (issue #105, Task 3) ───────────────────────
//
// HOW these tests drive a `cost_update` frame, and what that does and does not
// prove. `fake_worker` has NO priced scenario — its canned turn emits no
// `cost_update` frame and never calls a provider, so neither a real main
// session's loop nor a dispatched child produces one, and a real dispatch's
// `SubagentMetrics.cost` is `None` (so the parent's fold emits nothing). Adding
// a priced fixture scenario means editing `src/bin/fake_worker.rs`, which is
// outside this task's files. So these tests inject the frame through
// `WorkerManager::hooks()` — the app's OWN `SessionWorkerHooks`, built by the
// same `SessionManagerBuilder::build` the production `setup_dirs` runs — which
// is the SAME call the production money path makes (`hooks.on_event(session,
// is_subagent, SinkFrame { … })`: the Worker pump makes it for every frame a
// session emits, and the parent's loop's own frames reach the router the same
// way). Everything downstream of that call is production code and production
// wiring: the router's gate, `apply_interactive_event`,
// `Db::record_session_cost`, the `TauriSink` re-emission, and the
// `list_sessions` / `resume_session` command surface.
//
// What is NOT proven here is who BUILDS the envelope: that is
// `emit_cost_update` / `fold_child_cost` (`harness/loop/emit.rs`, pinned in
// `harness/loop/tests/cost.rs`) — and, since the parent-keyed roll-up frame was
// deleted, no frame is built by `finish_subagent` at all. The payload below is
// copied from the emitter byte-for-byte.

/// One `cost_update` `SinkFrame` payload in the shape `emit_cost_update` writes
/// (`sessionId` = the session the money belongs to).
fn cost_frame(session_id: &str, cost_usd: f64, source: &str) -> WorkerInboundEvent {
    WorkerInboundEvent::SinkFrame {
        event: "interactive-event".to_string(),
        payload: json!({
            "sessionId": session_id,
            "seq": 0,
            "event": "cost_update",
            "payload": { "costUsd": cost_usd, "source": source },
        }),
    }
}

/// (issue #105) A session that showed a cost figure STILL SHOWS THE SAME
/// FIGURE after a close: the `cost_update` frames reach the row (the router →
/// `apply_interactive_event` → `record_session_cost` path, driven through the
/// app's real hooks) and `list_sessions` — the boot fetch a CLOSED session's
/// figure has — projects it back out as `costUsd`. The frames are also still
/// re-emitted to the UI exactly once each (persisting must not eat the live
/// frame).
///
/// The two injected frames are TWO TOTALS (`0.00001243` then `0.00002`), not
/// two deltas: since Fulcrum T2 every `cost_update` frame carries the session's
/// CUMULATIVE figure, so the row reads the LAST total. Under the retired
/// increment this scenario asserted the sum `0.00003243`; against a snapshot
/// store that reading is impossible, and the sum is exactly the number a replay
/// used to manufacture.
#[tokio::test]
async fn a_stored_cost_survives_a_close_and_a_list() {
    let dirs = TestDirs::new();
    let _server = seed_default_model(&dirs).await;
    let app = build_app(&dirs);
    let webview = app.webview.clone();
    let collector = EventCollector::new(&app, &["interactive-event"]);

    let info: SessionInfo = value_to(
        invoke_ok(
            &webview,
            "start_session",
            json!({ "cwd": dirs.cwd().display().to_string() }),
        )
        .await,
    );

    // Two frames (the loop emits one per priced call, each carrying the
    // session's total AFTER that call: the first call cost 0.00001243, the
    // second brought the session to 0.00002).
    let hooks = worker_manager(&app).hooks().clone();
    hooks.on_event(
        &info.session_id,
        false,
        cost_frame(&info.session_id, 0.00001243, "main"),
    );
    // Re-deliver the FIRST frame before the second lands: a replay is now a
    // no-op, and the UI must still see it (persistence is a side effect).
    hooks.on_event(
        &info.session_id,
        false,
        cost_frame(&info.session_id, 0.00001243, "main"),
    );
    hooks.on_event(
        &info.session_id,
        false,
        cost_frame(&info.session_id, 0.00002, "main"),
    );

    // The UI still gets ALL THREE frames verbatim (the persistence arm is a
    // side effect, not a replacement) — including the replay, which the store
    // absorbs silently.
    let frames = collector.find("interactive-event");
    assert_eq!(
        frames.len(),
        3,
        "each frame (replay included) is still re-emitted to the UI exactly once"
    );
    assert!(
        frames
            .iter()
            .all(|f| f["event"] == "cost_update" && f["payload"]["source"] == "main"),
        "the frames ride verbatim: {frames:?}"
    );

    // The close (the frontend's store drops its entry here — the row is what
    // survives).
    invoke_ok(
        &webview,
        "close_session",
        json!({ "sessionId": info.session_id }),
    )
    .await;

    // The boot fetch: the CLOSED session's row carries the LAST TOTAL.
    let rows = invoke_ok(
        &webview,
        "list_sessions",
        json!({ "includeArchived": true }),
    )
    .await;
    let row = rows
        .as_array()
        .expect("list_sessions returns an array")
        .iter()
        .find(|r| r["sessionId"] == info.session_id.as_str())
        .expect("the closed session is in list_sessions");
    let stored = row["costUsd"]
        .as_f64()
        .expect("a priced session's list row carries costUsd");
    assert!(
        (stored - 0.00002).abs() < 1e-12,
        "the listed costUsd is the last frame's TOTAL, got {stored} \
         (0.00003243 would be the retired delta-sum, and 0.00004483 would be \
         that sum plus the replay)"
    );
    // The row itself agrees (the same column, read without the projection).
    let d = db(&app);
    let raw = d
        .session(&info.session_id)
        .expect("the row load")
        .expect("the row exists");
    let raw = raw.cost_usd.expect("the column carries the figure");
    assert!(
        (raw - 0.00002).abs() < 1e-12,
        "the projection reports the stored column, not a recomputed figure"
    );
}

/// (issue #105 / D5 / ADR 0082) THE IPC BOUNDARY PIN: a session whose
/// provider never reported a cost has NO cost — `costUsd` is `null` (or
/// absent), NEVER `0`. `0` and "unknown" are different claims, and collapsing
/// them is the phantom-`$0.00` defect this field exists to avoid.
#[tokio::test]
async fn a_session_that_never_reported_cost_has_no_cost_field() {
    let dirs = TestDirs::new();
    let _server = seed_default_model(&dirs).await;
    let app = build_app(&dirs);
    let webview = app.webview.clone();

    let info: SessionInfo = value_to(
        invoke_ok(
            &webview,
            "start_session",
            json!({ "cwd": dirs.cwd().display().to_string() }),
        )
        .await,
    );
    // `start_session`'s own payload — the fresh session reports nothing.
    assert!(
        info.cost_usd.is_none(),
        "a fresh session's SessionInfo has no cost, got {:?}",
        info.cost_usd
    );

    // An UNPRICED turn (the canned stream carries no `cost_update` frame).
    let stop = invoke_ok(
        &webview,
        "send_prompt",
        json!({ "sessionId": info.session_id, "text": "hello" }),
    )
    .await;
    assert_eq!(stop, json!("end_turn"), "the turn settles");

    invoke_ok(
        &webview,
        "close_session",
        json!({ "sessionId": info.session_id }),
    )
    .await;

    let rows = invoke_ok(
        &webview,
        "list_sessions",
        json!({ "includeArchived": true }),
    )
    .await;
    let row = rows
        .as_array()
        .expect("list_sessions returns an array")
        .iter()
        .find(|r| r["sessionId"] == info.session_id.as_str())
        .expect("the closed session is in list_sessions");
    match row.get("costUsd") {
        // Absent is fine (`None` may be elided), `null` is fine (what serde
        // emits today) — but a NUMBER is the D5 defect.
        None | Some(Value::Null) => {}
        Some(other) => panic!(
            "a session that never reported a cost must never carry a number \
             for costUsd — `0` means 'a call reported a real zero' and the \
             renderer would print $0.00, got {other}"
        ),
    }
    // The typed read agrees (the same distinction on the Rust side).
    let json_row = serde_json::to_value(&info).expect("SessionInfo serializes");
    assert!(
        json_row["costUsd"].is_null(),
        "the fresh session's payload spells absence as null/absent, got {:?}",
        json_row.get("costUsd")
    );
}

/// (issue #105) A RESUMED session is handed its stored figure back: the
/// resume's `SessionInfo` (the payload `resume_session` returns, which the
/// frontend seeds its live accumulator from) carries the row's `costUsd`, so
/// the next priced call ADDS to the stored total instead of restarting it.
/// The resume's own `record_session` re-record must not clobber the column.
#[tokio::test]
async fn a_resumed_session_is_handed_back_the_stored_cost() {
    let dirs = TestDirs::new();
    let _server = seed_default_model(&dirs).await;
    let app = build_app(&dirs);
    let webview = app.webview.clone();

    let info: SessionInfo = value_to(
        invoke_ok(
            &webview,
            "start_session",
            json!({ "cwd": dirs.cwd().display().to_string() }),
        )
        .await,
    );
    let hooks = worker_manager(&app).hooks().clone();
    hooks.on_event(
        &info.session_id,
        false,
        cost_frame(&info.session_id, 0.5, "main"),
    );
    invoke_ok(
        &webview,
        "close_session",
        json!({ "sessionId": info.session_id }),
    )
    .await;

    let resumed: SessionInfo = value_to(
        invoke_ok(
            &webview,
            "resume_session",
            json!({ "sessionId": info.session_id, "cwd": dirs.cwd().display().to_string() }),
        )
        .await,
    );
    assert_eq!(
        resumed.session_id, info.session_id,
        "the resume re-uses the stored id"
    );
    let seeded = resumed
        .cost_usd
        .expect("the resume carries the stored figure (Trap 3's seed source)");
    assert!(
        (seeded - 0.5).abs() < 1e-12,
        "the resume hands back the stored total, got {seeded}"
    );
    // The resume's own `record_session` did not wipe the column.
    let d = db(&app);
    assert!(
        (d.session_cost(&info.session_id)
            .expect("the cost read")
            .expect("the figure survives the resume's re-record")
            - 0.5)
            .abs()
            < 1e-12,
        "resuming does not reset the stored figure"
    );
}

/// (issue #105, Fulcrum T2's one-writer form) THE PARENT'S MONEY THROUGH THE
/// REAL IPC SURFACE: a parent-keyed `cost_update` frame — the envelope the
/// parent's OWN loop emits, including the one `fold_child_cost` emits when a
/// child returns — lands on the PARENT's row AND is re-emitted to the UI
/// verbatim exactly once. This is the end-to-end half of the link the router
/// test (`a_parent_keyed_cost_frame_from_the_router_writes_the_parents_row`)
/// defers here. It runs against a REAL dispatched child (the `__subagent__`
/// fixture — the child's own hidden row exists) so both rows the two keys must
/// not confuse are present, and the parent's STORED figure equals the figure
/// under its own title.
///
/// TWO things this test used to assert and no longer does, both because the
/// parent-keyed ROLL-UP frame in `finish_subagent` is DELETED (a second writer
/// on the parent's store key loses the child's money to the parent's next
/// snapshot frame):
/// - it no longer claims the frame below is what `finish_subagent` emits — it
///   is now the envelope the PARENT's loop writes, `source: "main"`;
/// - the real dispatch is asserted to write NOTHING to the parent's row, which
///   is the absence checked end to end: the Supervisor adds no frame of its own.
///
/// The injected frame is still not production's EMISSION — `fake_worker` never
/// calls a provider, so neither the parent's loop nor the child produces a real
/// `cost_update` here. What IS production, downstream of the injection, is the
/// whole money path the fold depends on: `hooks.on_event` → the router's
/// `cost_update` gate → `apply_interactive_event` → `Db::record_session_cost` →
/// the `TauriSink` re-emission → `list_sessions`. The emission itself is pinned
/// loop-side (`a_delegating_parents_total_keeps_its_childs_money`) and the
/// absence of the old second writer is pinned in `subagent_flow.rs`'s
/// `rollup_tests`.
#[tokio::test]
async fn a_parent_keyed_cost_frame_lands_on_the_parents_row_and_still_re_emits() {
    let dirs = TestDirs::new();
    let _server = seed_default_model(&dirs).await;
    let app = build_app(&dirs);
    let webview = app.webview.clone();
    let collector = EventCollector::new(&app, &["subagent-session-started", "interactive-event"]);

    let info: SessionInfo = value_to(
        invoke_ok(
            &webview,
            "start_session",
            json!({ "cwd": dirs.cwd().display().to_string() }),
        )
        .await,
    );
    let stop = invoke_ok(
        &webview,
        "send_prompt",
        json!({ "sessionId": info.session_id, "text": "__subagent__" }),
    )
    .await;
    assert_eq!(stop, json!("end_turn"), "the parent's turn settles");
    let started = collector
        .wait_for("subagent-session-started", Duration::from_secs(30))
        .await
        .expect("the child was dispatched for real");
    let child_id = started["sessionId"]
        .as_str()
        .expect("the child id")
        .to_string();

    // THE ABSENCE, end to end: a real delegation, from start to teardown,
    // writes NOTHING to the parent's row. The fixture's child is never priced,
    // so there is no figure to fold — but the load-bearing half is that the
    // Supervisor added no frame of its own either. Under the deleted roll-up
    // this assertion would still read `None` for a never-priced child, so the
    // discriminating pin for the removal is `subagent_flow.rs`'s
    // `finish_subagent_emits_no_parent_keyed_cost_frame`, which drives a child
    // that DID spend; what this line guards is the wiring: the parent's row is
    // written by the parent's frames and nothing else.
    let d = db(&app);
    assert_eq!(
        d.session_cost(&info.session_id)
            .expect("the parent cost read"),
        None,
        "a real delegation writes no parent-keyed money frame of its own"
    );

    // The frame the PARENT's loop emits for its own session — the envelope
    // `emit_cost_update` writes, and the same envelope `fold_child_cost` emits
    // with the child's figure already added in: the PARENT's id, `is_subagent:
    // false`, `source: "main"`, `seq: 0`.
    let hooks = worker_manager(&app).hooks().clone();
    hooks.on_event(
        &info.session_id,
        false,
        cost_frame(&info.session_id, 0.0000341, "main"),
    );

    assert_eq!(
        d.session_cost(&info.session_id)
            .expect("the parent cost read"),
        Some(0.0000341),
        "the parent's own frame writes the PARENT's row (the parent's stored \
         figure agrees with the figure under its own title — and when the frame \
         came from the fold, that figure includes its children)"
    );
    assert_eq!(
        d.session_cost(&child_id).expect("the child cost read"),
        None,
        "a parent-keyed frame is the PARENT's money — it must not touch the \
         child's row"
    );

    // The UI half: the frame is re-emitted verbatim, exactly once.
    let frames: Vec<Value> = collector
        .find("interactive-event")
        .into_iter()
        .filter(|f| f["event"] == "cost_update")
        .collect();
    assert_eq!(
        frames.len(),
        1,
        "the parent's frame reaches the UI exactly once (persisting does not eat it)"
    );
    assert_eq!(frames[0]["sessionId"], info.session_id.as_str());
    assert_eq!(frames[0]["seq"], json!(0));
    assert_eq!(frames[0]["payload"]["source"], "main");
    assert_eq!(frames[0]["payload"]["costUsd"], json!(0.0000341));

    // And it survives the close, on the list the frontend reads at boot.
    invoke_ok(
        &webview,
        "close_session",
        json!({ "sessionId": info.session_id }),
    )
    .await;
    let rows = invoke_ok(
        &webview,
        "list_sessions",
        json!({ "includeArchived": true }),
    )
    .await;
    let row = rows
        .as_array()
        .expect("list_sessions returns an array")
        .iter()
        .find(|r| r["sessionId"] == info.session_id.as_str())
        .expect("the closed session is in list_sessions");
    assert_eq!(
        row["costUsd"],
        json!(0.0000341),
        "the parent's LISTED figure is the total its own frames carried"
    );
}

/// The `attention_disarm` registration check (Task 6's one deliberate
/// deviation from the plan, which said not to add command tests here): the
/// wiring no unit test can see — that the command name resolves and that
/// `setup_dirs_with_factory` manages the `Arc<AttentionTimer>` the command
/// takes as state. A typo'd name, a missing `generate_handler!` entry HERE, or
/// a missing `app.manage(...)` all surface as an `Err` payload
/// (`command attention_disarm not found` / `managed state ... not found`)
/// instead of a silent no-op at runtime in the app.
///
/// Deliberately `disarm` and NEVER `attention_arm`: arming would start a real
/// countdown that could show a real OS notification on the developer's
/// desktop. `disarm` with nothing armed is the idempotent no-op, so it is safe
/// to send for real.
///
/// Scope of the claim: this harness declares its OWN `generate_handler!` list,
/// so it proves the command + the managed state are wired, NOT that the real
/// `lib.rs` handler list lists both commands (that is `lib.rs:237-238`, read
/// directly) and not that the JS wrapper spells the name the same
/// (`src/lib/tauri.test.ts` pins `attention_arm` / `attention_disarm`).
#[tokio::test]
async fn attention_disarm_resolves_through_the_real_ipc_surface() {
    let dirs = TestDirs::new();
    let app = build_app(&dirs);
    // The managed state the command needs, put there by the SAME
    // `setup_dirs_with_factory` the app runs (not a test-local `manage`).
    assert!(
        app.handle
            .try_state::<Arc<archimedes_lib::attention::AttentionTimer>>()
            .is_some(),
        "the Supervisor manages the `AttentionTimer`"
    );
    // The Ok arm (an unregistered command or an unmanaged state is the Err arm,
    // which `invoke_ok` fails on with the payload in the message). `Ok(())`
    // serialises to `null`.
    let payload = invoke_ok(&app.webview, "attention_disarm", json!({})).await;
    assert_eq!(payload, Value::Null, "`attention_disarm` returns `Ok(())`");
}

/// The three LIST-ORDER commands (ADR 0075, T02) resolve through the real IPC
/// surface: `session_recency`, `reorder_sessions` and `reorder_spaces` are
/// declared in this harness's `generate_handler!` list and the `Arc<Db>` they
/// need is managed by the same `setup_dirs_with_factory` the app runs.
///
/// ONE test drives all three names, because what it proves is per-NAME (name
/// resolution + managed-state wiring), not per-interaction — three mock apps
/// would buy no extra signal. The argument lists are EMPTY on purpose: an empty
/// reorder is the idempotent no-op T01 defines (an unknown/absent id is a 0-row
/// `UPDATE`), so the test touches no real data while still exercising the
/// `Vec<String>` argument decoding, and `session_recency` on the fresh boot `Db`
/// answers the empty array. An unregistered name or an unmanaged `Arc<Db>` is
/// the Err arm, which `invoke_ok` fails on with the payload in the message.
///
/// Scope of the claim, as the `attention_disarm` pin above states: this harness
/// declares its OWN handler list, so it does NOT prove `lib.rs` lists the three
/// commands — that is the `generate_handler!` block read directly.
#[tokio::test]
async fn the_list_order_commands_resolve_through_the_real_ipc_surface() {
    let dirs = TestDirs::new();
    let app = build_app(&dirs);
    assert!(
        app.handle.try_state::<Arc<Db>>().is_some(),
        "the setup manages the `Arc<Db>` all three commands take"
    );

    let recency = invoke_ok(&app.webview, "session_recency", json!({})).await;
    assert_eq!(
        recency,
        Value::Array(Vec::new()),
        "`session_recency` returns the array (empty on a fresh database)"
    );

    let sessions = invoke_ok(&app.webview, "reorder_sessions", json!({ "ids": [] })).await;
    assert_eq!(
        sessions,
        Value::Null,
        "`reorder_sessions` with an empty slice returns `Ok(())`"
    );

    let spaces = invoke_ok(&app.webview, "reorder_spaces", json!({ "paths": [] })).await;
    assert_eq!(
        spaces,
        Value::Null,
        "`reorder_spaces` with an empty slice returns `Ok(())`"
    );
}

/// (#85) A provider refresh must reach LIVE sessions, not just new ones.
///
/// The bug this pins: the context window is copied into the `AgentLoop` at spawn
/// (`loop.rs:290` — `Compactor::new(catalog.compaction, model.context_window)`)
/// and the only other writer is `set_model`, reached solely from a config-option
/// change. `list_models(force_refresh)` therefore refreshed the discovery cache
/// (so a NEW session saw the corrected window) while every running session kept
/// the stale one — and, because that same window is the compaction threshold's
/// input (ADR 0028's "one number, two consumers"), it silently over-compacted at
/// the stale window's percentage.
///
/// THE OBSERVATION POINT IS `config-ack`, not a `context_usage_update` frame: the
/// `fake_worker` fixture is a protocol stub with no `AgentLoop`, so it never emits
/// a usage frame. What this test can prove — and what the fix is responsible for —
/// is that the corrected `Model` is DELIVERED to the running Worker over
/// `Config { model }`. That the loop then applies it (rebuilt `Compactor`, re-emit,
/// re-persist) is already pinned by
/// `agent::harness::loop::tests::context_usage`'s `set_model` test; the two
/// together cover the path end to end without this file re-testing the loop.
#[tokio::test]
async fn refreshing_a_provider_pushes_the_new_context_window_to_a_live_session() {
    let dirs = TestDirs::new();
    // The provider first reports a 256k window — the user's STALE starting state.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("the discovery listener binds");
    let addr = listener.local_addr().unwrap();
    let settings = json!({
        "providers": [
            { "id": "tama", "name": "tama", "baseUrl": format!("http://{addr}/v1"),
              "apiKey": "k", "api": "openai-completions" }
        ],
        "defaultModel": "tama/m/1",
        // ISOLATION (see `seed_default_model`): naming defaults ON and is
        // nudged from the non-droppable Supervisor sites, so this mock
        // server would otherwise receive an unexpected chat-completion from
        // a test that only tests the context-window push.
        "sessionNamingEnabled": false
    });
    std::fs::write(
        dirs.config_dir.join("settings.json"),
        serde_json::to_string(&settings).unwrap(),
    )
    .expect("settings.json writes");
    let _server = serve_models_then_corrected(listener).await;

    let app = build_app(&dirs);
    let webview = app.webview.clone();
    let collector = EventCollector::new(&app, &["config-ack"]);

    // A session starts on the STALE metadata — the reproduction.
    let info: SessionInfo = value_to(
        invoke_ok(
            &webview,
            "start_session",
            json!({ "cwd": dirs.cwd().display().to_string() }),
        )
        .await,
    );
    let session_id = info.session_id.clone();
    // Nothing may have pushed a `Config { model }` yet (a `start` carries the
    // model in the envelope, not as a Config frame).
    assert_eq!(
        collector.find("config-ack").len(),
        0,
        "starting a session pushes no Config frame"
    );

    // The provider's metadata is CORRECTED to 1M (the stub's second response) and
    // the user presses refresh in Settings — exactly `list_models(force_refresh)`.
    invoke_ok(&webview, "list_models", json!({ "forceRefresh": "tama" })).await;

    // THE ASSERTION: the LIVE session is handed the corrected window, without a
    // restart, a resume, or a config-option change.
    let ack = collector
        .wait_for("config-ack", Duration::from_secs(15))
        .await
        .expect("the refresh pushes the corrected model to the live session");
    assert_eq!(
        ack["model"]["context_window"], 1000000,
        "the live session's window follows the provider refresh — the bar AND the \
         compaction threshold (ADR 0028's one number, two consumers); payload: {ack}"
    );

    let _ = invoke_ok(
        &webview,
        "close_session",
        json!({ "sessionId": session_id }),
    )
    .await;
}

/// A `GET /v1/models` stub whose FIRST response reports a 256k context window and
/// whose SECOND (and every later) response reports 1M — the "the provider's
/// metadata was corrected" transition (#85), with no listener rebinding (which
/// would race the previous server's `abort`: the port is still bound for a moment
/// after the handle is dropped, so `AddrInUse` is the failure, not the bug under
/// test).
async fn serve_models_then_corrected(
    listener: tokio::net::TcpListener,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut served = 0u32;
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mut buf = [0u8; 4096];
            let mut data = Vec::new();
            while !data.windows(4).any(|w| w == b"\r\n\r\n") {
                let Ok(n) = stream.read(&mut buf).await else {
                    break;
                };
                if n == 0 {
                    break;
                }
                data.extend_from_slice(&buf[..n]);
            }
            let body = if served == 0 {
                r#"{"data":[{"id":"m/1","max_model_len":256000}]}"#
            } else {
                r#"{"data":[{"id":"m/1","max_model_len":1000000}]}"#
            };
            served += 1;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(resp.as_bytes()).await;
        }
    })
}

/// (#85) The other half of the refresh contract: a refresh that does NOT move the
/// window must push NOTHING.
///
/// `set_model` is not free — it rebuilds the `Compactor`, re-estimates the
/// context, emits a `context_usage_update` frame and writes the `sessions` row.
/// Firing it unconditionally on every refresh would mean one frame plus one DB
/// write per live session for no change at all, on the settings page's most-used
/// button. This pins the guard so a later "simplification" to an unconditional
/// push fails here rather than as a quiet write amplification.
#[tokio::test]
async fn refreshing_a_provider_with_unchanged_metadata_pushes_nothing() {
    let dirs = TestDirs::new();
    // The provider reports the SAME window on both reads (the steady state).
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("the discovery listener binds");
    let addr = listener.local_addr().unwrap();
    let settings = json!({
        "providers": [
            { "id": "tama", "name": "tama", "baseUrl": format!("http://{addr}/v1"),
              "apiKey": "k", "api": "openai-completions" }
        ],
        "defaultModel": "tama/m/1",
        // ISOLATION (see `seed_default_model`): naming defaults ON and is
        // nudged from the non-droppable Supervisor sites, so this mock
        // server would otherwise receive an unexpected chat-completion from
        // a test that only tests the no-op refresh.
        "sessionNamingEnabled": false
    });
    std::fs::write(
        dirs.config_dir.join("settings.json"),
        serde_json::to_string(&settings).unwrap(),
    )
    .expect("settings.json writes");
    let _server = archimedes_lib::test_support::raw_json_server(
        listener,
        200,
        r#"{"data":[{"id":"m/1","max_model_len":256000}]}"#,
        None,
    )
    .await;

    let app = build_app(&dirs);
    let webview = app.webview.clone();
    let collector = EventCollector::new(&app, &["config-ack"]);

    let info: SessionInfo = value_to(
        invoke_ok(
            &webview,
            "start_session",
            json!({ "cwd": dirs.cwd().display().to_string() }),
        )
        .await,
    );
    let session_id = info.session_id.clone();

    // A refresh whose discovery returns the SAME window.
    invoke_ok(&webview, "list_models", json!({ "forceRefresh": "tama" })).await;
    // Give a spurious push time to land before asserting its absence — a bare
    // "nothing arrived yet" check would pass even for a fix that pushes lazily.
    tokio::time::sleep(Duration::from_millis(750)).await;
    assert_eq!(
        collector.find("config-ack").len(),
        0,
        "an unchanged window must not produce a Config push (no frame, no DB write)"
    );

    let _ = invoke_ok(
        &webview,
        "close_session",
        json!({ "sessionId": session_id }),
    )
    .await;
}
