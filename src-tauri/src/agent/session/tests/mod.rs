use super::*;
use crate::agent::events::RpcEvent;
use crate::agent::harness::provider::{
    ChatMessage, ChatRole, FinishReason, MessageContent, ModelRequest, ProviderError, ProviderEvent,
};
use crate::agent::worker::client::{WorkerError, WorkerHandle};
use crate::agent::worker::manager::WorkerFactory;
use crate::storage::Db;
use crate::test_support::ScratchDir;
use futures_util::stream::{BoxStream, StreamExt};
use std::path::Path;
use std::time::Duration;
use tokio::sync::mpsc;

#[test]
fn mint_session_id_format() {
    let sid = mint_session_id();
    assert!(
        sid.starts_with("arch_"),
        "session id must start with arch_, got {sid}"
    );
    let suffix = &sid["arch_".len()..];
    let parsed = uuid::Uuid::parse_str(suffix).expect("suffix must be valid UUID");
    assert_eq!(parsed.get_version_num(), 4, "suffix must be UUID v4");
}

/// A recording `EventSink` (`{"event", "payload"}` per emit). The
/// sender is `pub(crate)` so a CHILD module's tests (`session::naming`)
/// can construct one and assert on what it received.
pub struct TestSink {
    pub(crate) tx: mpsc::UnboundedSender<Value>,
}

impl EventSink for TestSink {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self
            .tx
            .send(serde_json::json!({ "event": event, "payload": payload }));
    }
}

/// A scratch config dir for ONE test, OWNED (#96 task 04): it is removed
/// when the caller's binding drops, so a fixture cannot forget — the shape
/// that leaked 32 dirs per green run (31 minting sites, 18 cleanups).
///
/// NAME CHANGE, recorded deliberately: this used to mint a BARE UUID with
/// no prefix at all, which #96's census could not attribute to ANY
/// producer. `ScratchDir` names `{prefix}{tag}-{uuid}`, so a prefix had to
/// be added — `session-cfg-` makes the issue's largest bucket readable as
/// well as empty. `create_dir` → `create_dir_all` is `ScratchDir::in_dir`'s
/// own behaviour and is unobservable here (a UUID-suffixed name never
/// pre-exists).
pub fn temp_config_dir() -> ScratchDir {
    ScratchDir::in_env_temp("session-cfg-", "cfg")
}

/// A `Db` in the temp dir (shared with `session::naming`'s tests).
pub(crate) fn open_db(dir: &Path) -> std::sync::Arc<Db> {
    std::sync::Arc::new(Db::open(&dir.join("archimedes.db")).expect("db should open"))
}

/// (ADR 0016) The NATIVE resume carries the stored `archived` flag:
/// a fresh native start is `archived: false`; after
/// `set_session_archived`, the resumed `SessionInfo` reports the stored
/// flag and the resume's `record_session` re-record did NOT clear it.
#[tokio::test]
async fn native_resume_carries_the_archived_flag() {
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, _wm, db) = build_worker_manager(&dir, native_test_catalog(), &sink);

    let info = manager
        .start_session(dir.to_path_buf(), &sink)
        .await
        .expect("the native session started");
    assert!(!info.archived, "a fresh native start is never archived");
    db.set_session_archived(&info.session_id, true)
        .expect("set_session_archived should succeed");

    let resumed = manager
        .resume_session(&info.session_id, dir.to_path_buf(), &sink)
        .await
        .expect("the native resume succeeded");
    assert_eq!(resumed.session_id, info.session_id);
    assert!(
        resumed.archived,
        "the native resume carries the stored archived flag"
    );
    let row = db
        .session(&info.session_id)
        .expect("session should work")
        .expect("the row exists");
    assert!(
        row.archived,
        "the resume's re-record did not clear the stored flag"
    );

    let _ = manager.close_session(&info.session_id).await;
}

/// The title round-trip over IPC: a FRESH start carries `None` (nothing
/// has named it yet), and a RESUME carries the stored title (the naming
/// pass wrote it on an earlier turn — the resumed session's label must
/// survive the close/resume round-trip) while the resume's
/// `record_session` re-record did NOT clear it.
#[tokio::test]
async fn native_resume_carries_the_stored_title() {
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, _wm, db) = build_worker_manager(&dir, native_test_catalog(), &sink);

    let info = manager
        .start_session(dir.to_path_buf(), &sink)
        .await
        .expect("the native session started");
    assert_eq!(
        info.title, None,
        "a fresh session has no title until the naming pass writes one"
    );
    db.set_session_title(&info.session_id, "Fix the login redirect")
        .expect("set_session_title should succeed");

    let resumed = manager
        .resume_session(&info.session_id, dir.to_path_buf(), &sink)
        .await
        .expect("the native resume succeeded");
    assert_eq!(resumed.session_id, info.session_id);
    assert_eq!(
        resumed.title.as_deref(),
        Some("Fix the login redirect"),
        "the native resume carries the stored title"
    );
    let row = db
        .session(&info.session_id)
        .expect("session should work")
        .expect("the row exists");
    assert_eq!(
        row.title.as_deref(),
        Some("Fix the login redirect"),
        "the resume's re-record did not clear the stored title"
    );

    let _ = manager.close_session(&info.session_id).await;
}

/// (ADR 0016) `SessionInfo` round-trips the `archived` flag (a
/// single-word key — the `camelCase` rename leaves it as `archived`).
#[test]
fn session_info_round_trips_the_archived_flag_camel_case() {
    let info = SessionInfo {
        session_id: "s1".to_string(),
        cwd: PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({ "loadSession": true }),
        config_options: None,
        archived: true,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    };
    let json = serde_json::to_string(&info).unwrap();
    assert!(json.contains("\"archived\":true"), "got: {json}");
    let back: SessionInfo = serde_json::from_str(&json).unwrap();
    assert!(back.archived);
}

/// (#105 / D5 / ADR 0082) The `SessionInfo` SERDE boundary for the cost
/// field: it crosses as `costUsd` (the struct's `camelCase` rename), and
/// `None` vs `Some(0.0)` stay two different payloads — `null` and `0`.
/// The renderer prints nothing for the first and `$0.00` for the second,
/// so a projection or a deserialisation that collapses them is the exact
/// phantom-`$0.00` defect; this is the same distinction
/// `a_session_that_never_reported_cost_has_no_cost_field` pins through
/// the real IPC surface, asserted here at the type so a break in serde
/// config (not just in the projection) is attributable.
#[test]
fn session_info_serialises_the_cost_as_cost_usd_and_keeps_zero_distinct() {
    let base = SessionInfo {
        session_id: "s1".to_string(),
        cwd: PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({ "loadSession": true }),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        is_subagent: false,
        cost_usd: None,
    };

    let absent = serde_json::to_value(&base).unwrap();
    assert!(
        absent.get("costUsd").is_some(),
        "the key is the camelCase `costUsd`, got: {absent}"
    );
    assert!(
        absent["costUsd"].is_null(),
        "`None` serialises as null — never as a number"
    );

    let zero = SessionInfo {
        cost_usd: Some(0.0),
        ..base.clone()
    };
    let zero_json = serde_json::to_value(&zero).unwrap();
    assert_eq!(
        zero_json["costUsd"],
        serde_json::json!(0.0),
        "a REAL zero serialises as 0 — the two are different payloads"
    );
    assert_ne!(
        absent["costUsd"], zero_json["costUsd"],
        "the wire must keep 'never reported' and 'reported zero' apart"
    );

    // `#[serde(default)]`: a payload written before the field existed
    // still deserialises, as `None`.
    let pre_feature: SessionInfo = serde_json::from_value(serde_json::json!({
        "sessionId": "s1",
        "cwd": "/tmp/proj",
        "capabilities": { "loadSession": true },
        "configOptions": null,
        "archived": false,
        "contextUsage": null,
    }))
    .expect("a pre-cost SessionInfo deserialises");
    assert_eq!(
        pre_feature.cost_usd, None,
        "an absent key reads back as None, not 0"
    );
}

/// Write a `settings.json` with the given `defaultModel` (the
/// camelCase wire shape — `None` = the key present-but-null, which
/// parses to `default_model: None`).
fn write_settings_default_model(dir: &Path, default_model: Option<&str>) {
    let settings = serde_json::json!({ "defaultModel": default_model });
    std::fs::write(
        dir.join("settings.json"),
        serde_json::to_string_pretty(&settings).unwrap(),
    )
    .unwrap();
}

// ── Native-backend tests (the in-process `AgentLoop` — a NATIVE
// registry entry + a mock `provider_factory` seam; the production
// default dispatches on `Model.api` (`build_provider`, ADR 0024)) ──

/// The native test catalog (a single `fake/m1` OpenAI-compatible
/// model — `set_config_option` + `resolve_native_model` resolve it
/// from the composed key).
fn native_test_catalog() -> ModelCatalog {
    ModelCatalog {
        models: vec![Model {
            id: "m1".to_string(),
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
        }],
        default_model: Some("fake/m1".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    }
}

/// The `fake_worker` fixture factory (the `WorkerFactory` seam —
/// `cargo test` builds the bin targets; the fixture answers the
/// `ready` handshake + the `start` / `prompt` frames; the
/// `AgentLoop` runs in the fixture process, NOT in-process —
/// ADR 0025).
struct FixtureFactory;

impl WorkerFactory for FixtureFactory {
    fn spawn(&self) -> Result<WorkerHandle, WorkerError> {
        WorkerHandle::spawn(&fixture_path())
    }
}

/// The `fake_worker` fixture path (the WORKSPACE ROOT's `target/debug` —
/// the cargo root moved to the repo root with the T4 `[workspace]`;
/// `cargo test` builds the bin targets).
fn fixture_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("the src-tauri package has a parent (the repo root)")
        .join("target/debug/fake_worker")
}

/// Build the Worker-mediated manager (the ADR 0025 late-wire — the
/// `WorkerManager`'s `on_event` / `on_crash` callbacks point at the
/// `SessionManager`'s router / crash handler; `attach_worker_manager`
/// hands the `WorkerManager` to the `SessionManager` after both are
/// built). Returns the manager + the `WorkerManager` + the `Db`.
///
/// The naming pass's provider seam is wired to the canned-title double
/// (see `build_worker_manager_with_title_provider`) — the whole suite,
/// because the double is inert unless a title request is actually made.
fn build_worker_manager(
    dir: &Path,
    catalog: ModelCatalog,
    sink: &Arc<dyn EventSink>,
) -> (Arc<SessionManager>, Arc<WorkerManager>, Arc<Db>) {
    let (manager, wm, db, _requests) =
        build_worker_manager_with_title_provider(dir, catalog, sink, false);
    (manager, wm, db)
}

/// `build_worker_manager` PLUS the naming provider's request channel —
/// the observation point for the tests that must SEE a title request
/// (`close_session` / `send_prompt_with_images` nudge the naming pass;
/// nothing else in this module does). `pending` scripts the double to
/// never answer, which keeps a request IN FLIGHT (the in-flight-guard
/// pin).
fn build_worker_manager_with_title_provider(
    dir: &Path,
    catalog: ModelCatalog,
    sink: &Arc<dyn EventSink>,
    pending: bool,
) -> (
    Arc<SessionManager>,
    Arc<WorkerManager>,
    Arc<Db>,
    mpsc::UnboundedReceiver<ModelRequest>,
) {
    let db = open_db(dir);
    let mut manager = SessionManager::new(dir.to_path_buf());
    manager.attach_db(db.clone());
    manager.set_catalog(catalog);
    manager.set_sink(sink.clone());
    // The naming pass's provider seam (`set_provider_factory` is
    // `&mut self`, so it goes in BEFORE the `Arc`). SAFE FOR THE WHOLE
    // HELPER: `provider_factory` has exactly ONE consumer — the title
    // request in `naming.rs` — so no other `tests`-module behaviour
    // changes; and the double answers in memory, so a nudge can never
    // reach the network from here.
    let (tx, requests) = mpsc::unbounded_channel::<ModelRequest>();
    manager.set_provider_factory(move |_model: &Model| {
        Box::new(CannedTitleProvider {
            requests: tx.clone(),
            pending,
        }) as Box<dyn Provider>
    });
    let manager = Arc::new(manager);
    let wm = {
        let m = manager.clone();
        let m2 = manager.clone();
        Arc::new(WorkerManager::new(
            Arc::new(FixtureFactory),
            Arc::new(move |s, c, p| m.handle_crash(&s, c, p)),
            Arc::new(move |s, b, e| m2.route_event(&s, b, e)),
            Arc::new(|_s| None),
        ))
    };
    manager.attach_worker_manager(wm.clone());
    (manager, wm, db, requests)
}

// ── (Fulcrum T3) The `config-update` push trigger ──────────────────────

/// THE production trigger: a Settings SAVE pushes `config-update` to every
/// live Worker, and the registry's STORED env is refreshed with it.
///
/// Why this test and not only the frame's unit tests: `Inbound::ConfigUpdate`
/// can exist, decode, and be routed by the Worker, and the whole suite stays
/// green while NO PRODUCTION PATH EVER SENDS IT. That is the failure mode the
/// status file's T3 escalation named — a push nobody pushes is worse than a
/// documented loss, because the green suite says live-reload works. So this
/// asserts the trigger itself, against a real attached `fake_worker`.
///
/// The second assertion is the half that reaches CHILDREN: a child's five
/// packaged fields are read from the PARENT's stored env
/// (`DesktopConfig::from_env(&parent_env)`), so an un-mirrored registry entry
/// would hand the next subagent the PRE-EDIT policy — ADR 0023's
/// next-dispatch property, silently broken.
#[tokio::test]
async fn save_settings_pushes_config_update_to_a_live_worker() {
    let dir = temp_config_dir();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, wm, _db, _requests) =
        build_worker_manager_with_title_provider(&dir, native_test_catalog(), &sink, false);

    // A live session: a row (what `push_config_update` iterates) AND an
    // attached Worker (what the frame is sent to).
    let env = StartEnv::from_parts(
        "push-sess".to_string(),
        "/tmp".to_string(),
        crate::agent::worker::protocol::StartMode::Fresh,
        None,
        native_test_catalog().models[0].clone(),
        native_test_catalog(),
        None,
        true,
        None,
        dir.display().to_string(),
        false,
        None,
        None,
    );
    wm.attach("push-sess", &env).await.expect("attach");
    manager.with_session_entry("push-sess", |row| {
        row.live = Some(LiveWorkerSession {
            cwd: std::path::PathBuf::from("/tmp"),
            close_kind: Arc::new(StdMutex::new(None)),
            pending_turn: Arc::new(StdMutex::new(None)),
            cancel_requested: Arc::new(StdMutex::new(false)),
            pending_modal_ids: StdMutex::new(HashSet::new()),
        });
    });

    // The edited settings the user just saved: a policy that ASKS, and an
    // override layer naming one agent.
    let settings = crate::config::Settings {
        file_policy: crate::agent::policy::FilePolicy {
            reads: crate::agent::policy::AccessPolicy::Ask,
            writes: crate::agent::policy::AccessPolicy::Sandboxed,
            shell: crate::agent::policy::AccessPolicy::Ask,
            rules: Vec::new(),
        },
        agent_overrides: HashMap::from([(
            "scout".to_string(),
            crate::config::AgentOverrideFields {
                model: Some("fake/m1".to_string()),
                thinking: None,
                // ADR 0067: an empty list is ABSENT, never `Some(vec![])`.
                tools: None,
            },
        )]),
        ..crate::config::Settings::default()
    };

    let delivered = crate::commands::settings::save_settings_and_push(&manager, &settings)
        .await
        .expect("the save succeeds");
    assert_eq!(
        delivered, 1,
        "the live session's Worker got the frame (a push that reports zero              deliveries is the silent no-op this test exists to catch)"
    );

    // The frame really went out: the fixture echoes it as its
    // `config-update-ack` `SinkFrame`, re-emitted through the router onto
    // the manager's sink.
    let ack = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let v = rx.recv().await.expect("the sink stays open");
            if v["event"] == "config-update-ack" {
                return v;
            }
        }
    })
    .await
    .expect("the `config-update-ack` arrives — the frame crossed the pipe");
    assert_eq!(
        ack["payload"]["filePolicy"]["reads"], "ask",
        "the PUSHED policy is the one the Worker received (camelCase on              both sides — a casing mismatch drops the field silently): {ack}"
    );
    assert_eq!(
        ack["payload"]["agentOverrides"]["scout"]["model"], "fake/m1",
        "the override layer rides the same frame"
    );

    // The registry's STORED env is refreshed — the hop that gives the NEXT
    // dispatched child the edited values.
    let stored = wm.test_env_for("push-sess").expect("still attached");
    assert_eq!(
        stored.file_policy.reads,
        crate::agent::policy::AccessPolicy::Ask,
        "the parent's stored policy is the pushed one"
    );
    assert_eq!(
        stored
            .agent_overrides
            .get("scout")
            .and_then(|e| e.model.as_deref()),
        Some("fake/m1"),
        "and so is the override layer children inherit"
    );

    // The file was written too (the push is an ADDITION to the save, never
    // a replacement for it).
    let on_disk = crate::config::load_settings(&dir);
    assert_eq!(
        on_disk.file_policy.reads,
        crate::agent::policy::AccessPolicy::Ask,
        "`settings.json` still holds what the user saved"
    );

    wm.reap_all().await;
}

// ── The naming-provider double (the level-triggered-titling tests) ─────
//
// The minimal form of `naming.rs`'s `RecordingProvider` (module-private
// there, so it cannot be imported). The requests go out on an
// UNBOUNDED CHANNEL rather than a `Notify`: a `Notify` loses a signal
// that arrives BEFORE the test registers its waiter, and the
// prompt-start nudge fires while the test is still awaiting the turn
// settle — so the signal would be gone by the time the test looked.
// `recv()` after the fact is then still exact, because on a
// current-thread runtime the woken test task is polled only AFTER the
// naming task's poll ends, and everything the naming task does after
// handing back its stream is an immediately-ready await — so the
// conditional title write has already happened when `recv()` returns.

/// The canned title the double answers with.
const CANNED_TITLE: &str = "Porting the session namer";

/// The title-request `Provider` double.
struct CannedTitleProvider {
    /// Every request, in arrival order.
    requests: mpsc::UnboundedSender<ModelRequest>,
    /// Never answer (the request stays IN FLIGHT).
    pending: bool,
}

#[async_trait::async_trait]
impl Provider for CannedTitleProvider {
    async fn complete(
        &self,
        req: &ModelRequest,
    ) -> Result<BoxStream<'static, ProviderEvent>, ProviderError> {
        let _ = self.requests.send(req.clone());
        if self.pending {
            let () = futures_util::future::pending().await;
        }
        Ok(futures_util::stream::iter(vec![
            ProviderEvent::TextDelta(CANNED_TITLE.to_string()),
            ProviderEvent::Done(FinishReason::Stop),
        ])
        .boxed())
    }
}

/// A `ChatMessage` user row (the shape `native_messages` stores).
fn user_row(text: &str) -> ChatMessage {
    ChatMessage {
        role: ChatRole::User,
        content: MessageContent::Text(text.to_string()),
        tool_call_id: None,
        tool_calls: None,
    }
}

/// A `ChatMessage` assistant row.
fn assistant_row(text: &str) -> ChatMessage {
    ChatMessage {
        role: ChatRole::Assistant,
        content: MessageContent::Text(text.to_string()),
        tool_call_id: None,
        tool_calls: None,
    }
}

/// Seed the PREVIOUS turn's transcript into `native_messages` — the
/// table the naming pass counts interactions in and excerpts from (the
/// Worker's `TranscriptInsert` store frames land here; the Supervisor's
/// own `send_prompt` write goes to the DISPLAY `messages` table, so
/// naming never sees a prompt's own row).
fn seed_previous_turn(db: &Arc<Db>, id: &str) {
    let store = SessionStore::new(db.clone());
    store
        .insert_message(
            id,
            0,
            "user",
            &serde_json::to_string(&user_row("Fix the login redirect")).unwrap(),
        )
        .expect("the user row writes");
    store
        .insert_message(
            id,
            1,
            "assistant",
            &serde_json::to_string(&assistant_row("Point the redirect at /login")).unwrap(),
        )
        .expect("the assistant row writes");
}

/// Let every spawned task run to its next await point — the NEGATIVE
/// assertions need it (without a yield, "no request was made" would pass
/// vacuously on a current-thread runtime). The `naming.rs` harness's
/// `drain_tasks` shape.
async fn drain_tasks() {
    for _ in 0..3 {
        tokio::task::yield_now().await;
    }
}

/// Read the row until the naming pass's conditional write lands (the
/// write happens inside the spawned task). The bounded `yield_now` loop
/// is a scheduling guard, not a sleep-based "give it time" — the request
/// channel is what proves the pass ran; a pass that never ran returns
/// `(None, 0)` and reddens the caller's assertion.
async fn stored_title(db: &Arc<Db>, id: &str) -> (Option<String>, i64) {
    for _ in 0..100 {
        let row = db
            .session(id)
            .expect("the row reads")
            .expect("the row exists");
        if row.title.is_some() {
            return (row.title, row.title_stage);
        }
        tokio::task::yield_now().await;
    }
    let row = db
        .session(id)
        .expect("the row reads")
        .expect("the row exists");
    (row.title, row.title_stage)
}

// ── Level-triggered titling (#143) ─────────────────────────────────────
//
// `agent_end` is titling's droppable trigger: it rides the Worker
// client's 256-slot `broadcast` and a `Lagged` pump DROPS it, which is
// #143's "the title arrives late, or never". The two Supervisor-side
// nudges below are ordinary function calls and therefore cannot be
// dropped, so a session gets titled at the next prompt or at close even
// when the frame never arrived. These tests drive the REAL lifecycle
// (a `fake_worker` session, whose canned turn emits `turn_end` +
// `agent_settled` and NO `agent_end`) — the absence of the frame is the
// scenario, not an approximation of it.

/// #143: a session that NEVER receives `agent_end` is still titled by
/// `close_session` — the last chance before teardown, and a nudge that
/// no broadcast overflow can eat.
#[tokio::test]
async fn closing_a_session_titles_it_with_no_agent_end_frame_ever_delivered() {
    let dir = temp_config_dir();
    // Naming ON (the production default — `sessionNamingEnabled` absent
    // reads as enabled; this test is ABOUT the naming pass).
    write_settings_json(&dir, serde_json::json!({}));
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, _wm, db, mut requests) =
        build_worker_manager_with_title_provider(&dir, native_test_catalog(), &sink, false);
    let info = manager
        .start_session(dir.to_path_buf(), &sink)
        .await
        .expect("the native session started");
    let id = info.session_id.clone();
    // The PREVIOUS turn's transcript, in the table naming reads.
    seed_previous_turn(&db, &id);
    assert_eq!(db.session(&id).unwrap().unwrap().title_stage, 0);

    // NO `agent_end` is ever routed — the fixture never emits one.
    manager
        .close_session(&id)
        .await
        .expect("the close succeeds");

    let request = tokio::time::timeout(Duration::from_secs(5), requests.recv())
        .await
        .expect("close_session nudged the naming pass — a title request was made")
        .expect("the request channel is open");
    assert_eq!(
        request.model, "m1",
        "the request asks the session's own model (the BARE id)"
    );
    let (title, stage) = stored_title(&db, &id).await;
    assert_eq!(
        title.as_deref(),
        Some(CANNED_TITLE),
        "the close nudge wrote the title the provider answered with"
    );
    assert_eq!(stage, 1, "stage 0 -> 1 (the two-stage ladder)");
}

/// #143: the same untitled session gets titled at the NEXT prompt — the
/// "catch up on whatever is due" moment, naming from the PREVIOUS turn's
/// transcript (the prompt's own row is not visible to naming either way:
/// the Supervisor writes the DISPLAY row, the Worker writes
/// `native_messages`).
#[tokio::test]
async fn a_prompt_titles_an_untitled_session_from_the_previous_turn_with_no_agent_end() {
    let dir = temp_config_dir();
    write_settings_json(&dir, serde_json::json!({}));
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, _wm, db, mut requests) =
        build_worker_manager_with_title_provider(&dir, native_test_catalog(), &sink, false);
    let info = manager
        .start_session(dir.to_path_buf(), &sink)
        .await
        .expect("the native session started");
    let id = info.session_id.clone();
    seed_previous_turn(&db, &id);

    // The turn settles (the fixture's `agent_settled`) and NO `agent_end`
    // is ever routed for turn 1.
    manager
        .send_prompt_with_images(&id, "and the tests?".to_string(), Vec::new())
        .await
        .expect("the prompt turn resolved");

    let request = tokio::time::timeout(Duration::from_secs(5), requests.recv())
        .await
        .expect("the prompt start nudged the naming pass")
        .expect("the request channel is open");
    assert_eq!(request.model, "m1");
    let (title, stage) = stored_title(&db, &id).await;
    assert_eq!(
        title.as_deref(),
        Some(CANNED_TITLE),
        "the prompt nudge titled the session from the previous turn's transcript"
    );
    assert_eq!(stage, 1);

    let _ = manager.close_session(&id).await;
}

/// A nudge that arrives while a title request is already IN FLIGHT
/// spawns nothing — the `in_flight` guard (the same one
/// `naming.rs::a_request_in_flight_blocks_a_second` pins for the
/// `agent_end` trigger) covers the new call sites for free. This one
/// passes BEFORE the nudges land: it pins the property the nudges must
/// not break, so a nudge that over-spawns reddens it.
#[tokio::test]
async fn a_nudge_while_a_title_request_is_in_flight_spawns_no_second_one() {
    let dir = temp_config_dir();
    write_settings_json(&dir, serde_json::json!({}));
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    // `pending`: the double never answers, so the first request stays IN
    // FLIGHT and guard 4 — not the now-titled row — is what declines.
    let (manager, _wm, db, mut requests) =
        build_worker_manager_with_title_provider(&dir, native_test_catalog(), &sink, true);
    let info = manager
        .start_session(dir.to_path_buf(), &sink)
        .await
        .expect("the native session started");
    let id = info.session_id.clone();
    seed_previous_turn(&db, &id);

    // The first request, via the trigger that exists today.
    manager.route_event(
        &id,
        false,
        WorkerInboundEvent::Event(RpcEvent::agent_end {
            messages: vec![],
            will_retry: false,
        }),
    );
    tokio::time::timeout(Duration::from_secs(5), requests.recv())
        .await
        .expect("the first title request was made")
        .expect("the request channel is open");
    assert!(
        manager.naming_state(&id, |s| s.is_some_and(|s| s.in_flight)),
        "the request is in flight (the double never answered)"
    );

    // The extra nudge — the close-site call, on the same session.
    manager
        .close_session(&id)
        .await
        .expect("the close succeeds");
    drain_tasks().await;

    assert!(
        requests.try_recv().is_err(),
        "the in-flight guard declined the nudge: no second request"
    );
}

/// Stamp a seeded crash log's mtime `secs_ago` seconds in the past, so
/// a test can say which of two logs is the NEWER one without racing the
/// filesystem's mtime granularity.
fn stamp_crash_log(path: &Path, secs_ago: u64) {
    let mtime = std::time::SystemTime::now() - std::time::Duration::from_secs(secs_ago);
    std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .expect("the seeded crash log is re-openable")
        .set_modified(mtime)
        .expect("the seeded crash log's mtime is settable");
}

/// The two halves of crash-log attribution, on a REAL child pid:
///
/// **(a) identity** — the `stalled` registry's `crash_log` is the log
/// named for the pid that just died, NOT the newest log in the dir.
/// A second, NEWER, pid-less `crash-7-worker.log` is seeded beside it: a
/// recency rule names that foreign file, so this half is the identity
/// guarantee itself.
///
/// **(b) frozen equality** — the `session-stalled` payload's
/// `crashLog` is THE SAME path the registry froze. On its own this half
/// says nothing about WHICH file wins (a lookup re-run with the same pid
/// over an unchanged dir returns the same path), so do not expect a
/// today-red from it — it is the pin against re-globbing at the emit: a
/// second lookup there is exactly what re-opens the window in which
/// another Worker's crash moves the banner's link out from under the
/// registry. Seed-newer-besides-pid-named turns the cheapest regression
/// (a re-glob that forgets the pid) into a failure here.
#[tokio::test]
async fn the_stalled_registry_and_the_stalled_event_agree_on_the_pid_named_log() {
    let dir = temp_config_dir();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, _wm, _db) = build_worker_manager(&dir, native_test_catalog(), &sink);

    // A REAL child, so the pid is one the Supervisor really would hold.
    let handle = WorkerHandle::spawn(&fixture_path())
        .expect("the fixture binary exists (cargo test built it)");
    let pid = handle
        .pid()
        .expect("a live child reports its spawn-time pid");
    // Let it go GRACEFULLY: `kill_on_drop` is false for this child, so a
    // dropped handle leaves the process alive until its stdin EOF, and
    // the `worker_smoke` EOF/exit pins are sensitive to a stray child.
    handle.send_close().expect("the close frame encodes");
    handle.exited().await;

    // The crash-log dir — the late-wire seam (`setup_dirs_with_factory`
    // wires the app data dir here in production).
    let crash_dir = temp_config_dir();
    manager.set_crash_log_dir(crash_dir.to_path_buf());

    // The crashed Worker's own log, and a NEWER one belonging to nobody
    // we care about.
    let mine = crash_dir.join(format!("crash-1000-worker-{pid}.log"));
    std::fs::write(&mine, "mine").expect("the pid-named log is seedable");
    stamp_crash_log(&mine, 120);
    let foreign = crash_dir.join("crash-7-worker.log");
    std::fs::write(&foreign, "foreign").expect("the foreign log is seedable");
    stamp_crash_log(&foreign, 0);

    // `handle_crash` has no early return — it always marks the session
    // stalled and emits — and its `live`-map helpers no-op for an id
    // that was never started, so no Worker needs to be running here.
    let id = "arch_pid_attributed";
    manager.handle_crash(id, Some(1), Some(pid));

    // (a) Identity: the registry holds the pid-named log.
    let frozen = manager
        .stalled_info(id)
        .expect("the crash marks the session stalled")
        .crash_log;
    assert_eq!(
        frozen.as_deref(),
        Some(mine.as_path()),
        "the banner names the log belonging to pid {pid}, not the newer foreign one \
         (`{}`)",
        foreign.display()
    );

    // (b) Frozen equality: the PUSH names exactly what the registry
    // froze — one lookup per crash, never a re-glob.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    let payload = loop {
        let got = tokio::time::timeout_at(deadline, rx.recv())
            .await
            .expect("the `session-stalled` event is emitted")
            .expect("the sink is live");
        if got["event"] == "session-stalled" {
            break got["payload"].clone();
        }
    };
    assert_eq!(
        payload["crashLog"],
        serde_json::Value::String(mine.display().to_string()),
        "the `session-stalled` payload's `crashLog` is the path the registry froze \
         (a second glob would name the newer `{}`)",
        foreign.display()
    );
}

/// The **teardown prohibition** (ADR 0025, finding 13): the EXPECTED-exit
/// teardown must NEVER remove the `stalled` row.
///
/// This is the close-after-crash sequence the ADR's attribution survives,
/// and it is a REAL user sequence: a Worker crashes (`handle_crash` marks
/// the session STALLED + pushes the `session-stalled` banner) and the user
/// then `close_session`s that stalled session. The `detach` drops the
/// `workers` entry first, so the pump's `Exited` for that session computes
/// `is_exit_expected == true` and the router runs THIS teardown a second
/// time — with the banner possibly still reading the registry through
/// `get_stalled_info`. A teardown that removed the whole per-session row
/// would erase the crash attribution mid-read, and the row is the ONLY
/// record of the crash the backend keeps.
///
/// What the teardown DOES remove stays pinned by the same test: `live`
/// (`session_count` drops to 0) and, with it, the naming slice
/// (`naming.rs`'s `a_clean_exit_leaves_no_naming_entry`). `stalled` is the
/// one field that does not go — grow-only, bounded by DISTINCT crashed
/// sessions.
///
/// ⚠ The row must be SEEDED LIVE for this to pin anything. The plan's
/// literal snippet (crash + teardown on a never-started id) passes even
/// under a blanket "remove the row" — verified, not assumed: a temporary
/// blanket-remove made THIS test fail and left the unseeded shape green,
/// because `on_session_exited_expected` early-returns at its `live` guard
/// before reaching any removal. The seed below is what makes the assertion
/// bite.
#[tokio::test]
async fn a_stalled_row_is_frozen_until_the_next_crash() {
    let dir = temp_config_dir();
    let manager = SessionManager::new(dir.to_path_buf());
    let id = "arch_close_after_crash";
    // The session must be LIVE, or the teardown early-returns as "already
    // gone" and asserts nothing at all.
    manager.with_session_entry(id, |row| {
        row.live = Some(LiveWorkerSession {
            cwd: dir.to_path_buf(),
            close_kind: Arc::new(StdMutex::new(None)),
            pending_turn: Arc::new(StdMutex::new(None)),
            cancel_requested: Arc::new(StdMutex::new(false)),
            pending_modal_ids: StdMutex::new(HashSet::new()),
        });
    });

    // The crash: the `stalled` row is written, the `session-stalled` push
    // goes out (no sink wired here — the push is skippable, the row is not).
    manager.handle_crash(id, Some(1), None);
    assert!(
        manager.stalled_info(id).is_some(),
        "precondition: the crash marks the session stalled"
    );

    // The user closes the stalled session → the `detach` makes the Worker's
    // `Exited` EXPECTED → this is the teardown that runs.
    manager.on_session_exited_expected(id);

    assert_eq!(
        manager.session_count().await,
        0,
        "the close removed the session's live entry (the teardown ran to the end)"
    );
    assert!(
        manager.stalled_info(id).is_some(),
        "the `stalled` row survives the close-after-crash: it is the crash \
         attribution the frontend banner reads, so the expected-exit teardown \
         must never remove it"
    );
}

/// Start a native session with the given catalog (the Worker-mediated
/// path — the `fake_worker` fixture answers the `ready` handshake;
/// the Supervisor-side assertions run against the coordinator state).
async fn start_native_session_with_catalog(
    dir: &Path,
    sink: &Arc<dyn EventSink>,
    catalog: ModelCatalog,
) -> (Arc<SessionManager>, SessionInfo) {
    let (manager, _wm, _db) = build_worker_manager(dir, catalog, sink);
    let info = manager
        .start_session(dir.to_path_buf(), sink)
        .await
        .expect("the native session started");
    (manager, info)
}

/// Start a native session (the `native_test_catalog` — a single
/// `fake/m1` model).
async fn start_native_session(
    dir: &Path,
    sink: &Arc<dyn EventSink>,
) -> (Arc<SessionManager>, SessionInfo) {
    start_native_session_with_catalog(dir, sink, native_test_catalog()).await
}

/// A full `Model` literal for the `resolve_native_model` chain test
/// (`base_url` EMPTY so `refresh_model_metadata` is a no-op — no
/// network; `openai-completions` so the model is selectable).
fn chain_test_model(provider: &str, id: &str) -> Model {
    Model {
        id: id.to_string(),
        provider: provider.to_string(),
        base_url: String::new(),
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

/// The NATIVE capability envelope advertises `image: true` (the native
/// `Prompt` carries image blocks — the frontend's `imageCapable` gate
/// opens the paste / attach path; `false` was the v1 text-only shape).
#[test]
fn native_capabilities_advertises_image() {
    let caps = native_capabilities(&chain_test_model("fake", "m1"), None);
    assert_eq!(caps["native"], true);
    assert_eq!(caps["loadSession"], true);
    assert_eq!(
        caps["promptCapabilities"],
        json!({ "image": true, "audio": false, "embeddedContext": false })
    );
}

/// Write a `settings.json` with arbitrary JSON (the camelCase wire
/// shape — absent keys parse to the defaults).
pub(crate) fn write_settings_json(dir: &Path, settings: serde_json::Value) {
    std::fs::write(
        dir.join("settings.json"),
        serde_json::to_string_pretty(&settings).unwrap(),
    )
    .unwrap();
}

/// A `Model` with the given `thinking_levels` (`base_url` EMPTY so
/// `refresh_model_metadata` is a no-op — no network).
pub(crate) fn level_test_model(provider: &str, id: &str, levels: &[&str]) -> Model {
    Model {
        id: id.to_string(),
        provider: provider.to_string(),
        base_url: String::new(),
        api_key: "k".to_string(),
        context_window: 128000,
        cost_per_mtok_in: 0.0,
        cost_per_mtok_out: 0.0,
        supports_tools: true,
        supports_thinking: !levels.is_empty(),
        thinking_levels: levels.iter().map(|s| s.to_string()).collect(),
        api: Some("openai-completions".to_string()),
    }
}

/// (ADR 0015) Native start: the remembered level (VALIDATED against the
/// model's `thinking_levels`) wins over the harness's
/// `default_thinking_level` seed.
#[tokio::test]
async fn a_native_session_starts_with_the_remembered_level_over_the_settings_default() {
    let catalog = ModelCatalog {
        models: vec![level_test_model(
            "tama",
            "m1",
            &["off", "low", "medium", "xhigh"],
        )],
        default_model: Some("tama/m1".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    write_settings_json(
        &dir,
        serde_json::json!({
            "defaultModel": null,
            "defaultThinkingLevel": "high",
            "defaultThinkingLevels": { "tama/m1": "xhigh" },
        }),
    );
    let (manager, info) = start_native_session_with_catalog(&dir, &sink, catalog).await;
    assert_eq!(
        info.capabilities["thinkingLevel"], "xhigh",
        "the remembered (validated) level beats the settings default"
    );
    let _ = manager.close_session(&info.session_id).await;
}

/// A STALE remembered entry (not a member of the model's
/// `thinking_levels` — the provider changed its levels) is IGNORED, AND
/// the `Settings.default_thinking_level` rung is VALIDATED the same way
/// (the Settings UI offers the UNION of all models' levels — a level one
/// model advertises may not be a member of THIS model's set): a settings
/// default that is NOT a member is DROPPED (the session starts with no
/// thinking level — the model's own default).
#[tokio::test]
async fn a_stale_remembered_level_and_an_invalid_settings_default_start_with_no_level() {
    let catalog = ModelCatalog {
        models: vec![level_test_model(
            "tama",
            "m1",
            &["off", "low", "medium", "xhigh"],
        )],
        default_model: Some("tama/m1".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    write_settings_json(
        &dir,
        serde_json::json!({
            "defaultModel": null,
            "defaultThinkingLevel": "high",
            "defaultThinkingLevels": { "tama/m1": "ultra" },
        }),
    );
    let (manager, info) = start_native_session_with_catalog(&dir, &sink, catalog).await;
    assert!(
        info.capabilities.get("thinkingLevel").is_none(),
        "the stale entry is ignored AND the settings default (not a member of the model's levels) is dropped — no thinking level, got {:?}",
        info.capabilities
    );
    let _ = manager.close_session(&info.session_id).await;
}

/// The `Settings.default_thinking_level` rung APPLIES when it is a
/// member of the model's `thinking_levels` (no remembered entry):
/// the settings default is a validated rung, not a bypass.
#[tokio::test]
async fn a_settings_default_level_applies_when_it_is_a_member_of_the_model_levels() {
    let catalog = ModelCatalog {
        models: vec![level_test_model(
            "tama",
            "m1",
            &["off", "low", "medium", "xhigh"],
        )],
        default_model: Some("tama/m1".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    write_settings_json(
        &dir,
        serde_json::json!({
            "defaultModel": null,
            "defaultThinkingLevel": "xhigh",
        }),
    );
    let (manager, info) = start_native_session_with_catalog(&dir, &sink, catalog).await;
    assert_eq!(
        info.capabilities["thinkingLevel"], "xhigh",
        "a settings default that IS a member of the model's levels applies"
    );
    let _ = manager.close_session(&info.session_id).await;
}

/// (the stored rung's lenient rule, mirrored on the settings rung) A
/// model that advertises NO `thinking_levels` applies the
/// `Settings.default_thinking_level` AS-IS (no membership check — the
/// pre-change behavior).
#[tokio::test]
async fn a_settings_default_level_applies_as_is_for_a_model_without_levels() {
    let catalog = ModelCatalog {
        models: vec![level_test_model("tama", "m1", &[])],
        default_model: Some("tama/m1".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    write_settings_json(
        &dir,
        serde_json::json!({
            "defaultModel": null,
            "defaultThinkingLevel": "high",
        }),
    );
    let (manager, info) = start_native_session_with_catalog(&dir, &sink, catalog).await;
    assert_eq!(
        info.capabilities["thinkingLevel"], "high",
        "a model with no advertised levels applies the settings default as-is"
    );
    let _ = manager.close_session(&info.session_id).await;
}

/// (ADR 0015) A model that advertises NO `thinking_levels` gets NO
/// remembered level (the memory is only applied to a member of a
/// NON-EMPTY level set): the `thinkingLevel` key is ABSENT (the model's
/// own default — `None`).
#[tokio::test]
async fn a_remembered_level_is_ignored_for_a_model_without_levels() {
    let catalog = ModelCatalog {
        models: vec![level_test_model("tama", "m1", &[])],
        default_model: Some("tama/m1".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    write_settings_json(
        &dir,
        serde_json::json!({ "defaultThinkingLevels": { "tama/m1": "xhigh" } }),
    );
    let (manager, info) = start_native_session_with_catalog(&dir, &sink, catalog).await;
    assert!(
        info.capabilities.get("thinkingLevel").is_none(),
        "a model with no advertised levels gets no remembered level, got {:?}",
        info.capabilities
    );
    let _ = manager.close_session(&info.session_id).await;
}

/// (ADR 0015) An EXPLICIT `thought_level` change (native) persists
/// `memory[<the session's model key>] = level` to `settings.json`
/// (best-effort — the change itself is applied regardless).
#[tokio::test]
async fn a_native_thought_level_change_remembers_the_level() {
    let dir = temp_config_dir();
    write_settings_json(&dir, serde_json::json!({}));
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, info) = start_native_session(&dir, &sink).await;
    let _ = manager
        .set_config_option(&info.session_id, "thought_level", "medium", &sink)
        .await
        .expect("the level change applies");
    let settings = load_settings(&dir);
    assert_eq!(
        settings.default_thinking_levels.get("fake/m1"),
        Some(&"medium".to_string()),
        "the explicit change writes the memory for the session's model"
    );
    // The file on disk is updated (a fresh read — not just the in-memory map).
    let raw = std::fs::read_to_string(dir.join("settings.json")).unwrap();
    let on_disk: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(on_disk["defaultThinkingLevels"]["fake/m1"], "medium");
    let _ = manager.close_session(&info.session_id).await;
}

/// (review finding) An EMPTY `thought_level` value is rejected BEFORE
/// the control channel is touched (an empty level would flow
/// `reasoning_effort: Some("")` into the provider request body — some
/// endpoints reject it): a `Command` error, the mirror is UNCHANGED,
/// NO `config_option_update` is emitted (mirroring the model arm's
/// rejection of an unresolvable key).
#[tokio::test]
async fn a_native_empty_thought_level_change_is_rejected() {
    let dir = temp_config_dir();
    write_settings_json(&dir, serde_json::json!({}));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, info) = start_native_session(&dir, &sink).await;
    // Drain any startup events (the assertion below is about the
    // rejected change only).
    while rx.try_recv().is_ok() {}
    let err = manager
        .set_config_option(&info.session_id, "thought_level", "", &sink)
        .await
        .expect_err("an empty level must be rejected");
    assert!(
        matches!(
            err,
            SessionError::Command {
                ref error
            } if error == "a thinking level must be non-empty"
        ),
        "the empty level is rejected with a Command error, got {err:?}"
    );
    // The mirror is UNCHANGED (a fresh session has no level — an
    // applied change would have mirrored `Some("")`). The mirror's home
    // moved from the `NativeHandle` to the `SessionManager`'s
    // `config_state` slice of the `SessionManager`'s `sessions` row (the
    // `NativeHandle` is gone for main sessions).
    let state = manager
        .with_session(&info.session_id, |s| s.config_state.clone())
        .flatten()
        .expect("the session is live");
    assert_eq!(
        state.thinking_level.as_deref(),
        None,
        "the mirror must be untouched by a rejected change"
    );
    // NO `config_option_update` was emitted (a rejected change
    // re-synthesizes nothing).
    assert!(
        rx.try_recv().is_err(),
        "no event may be emitted for a rejected change"
    );
    let _ = manager.close_session(&info.session_id).await;
}

/// (ADR 0015) A native model switch is a MINIMAL-SURPRISE reset: the
/// current level is invalid for the NEW model (its `thinking_levels`
/// are non-empty and don't contain it) → the level resets to the new
/// model's remembered level (or `None`).
#[tokio::test]
async fn a_native_model_switch_resets_an_invalid_level_to_the_new_model_s_memory() {
    let catalog = ModelCatalog {
        models: vec![
            level_test_model("tama", "a", &["off", "high"]),
            level_test_model("tama", "b", &["off", "low", "medium", "xhigh"]),
        ],
        default_model: Some("tama/a".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    write_settings_json(
        &dir,
        serde_json::json!({ "defaultThinkingLevels": { "tama/b": "xhigh" } }),
    );
    let (manager, info) = start_native_session_with_catalog(&dir, &sink, catalog).await;
    // The current level (valid for `a` — also writes `a`'s memory).
    let _ = manager
        .set_config_option(&info.session_id, "thought_level", "high", &sink)
        .await
        .expect("the level change applies");
    // The switch: `"high"` is NOT a member of `b`'s levels → the reset
    // to `b`'s remembered level.
    let updated = manager
        .set_config_option(&info.session_id, "model", "tama/b", &sink)
        .await
        .expect("the model switch applies");
    let thought = updated
        .iter()
        .find(|o| o["id"] == "thought_level")
        .expect("a thought_level selector");
    assert_eq!(
        thought["currentValue"], "xhigh",
        "an invalid level resets to the new model's remembered level"
    );
    let _ = manager.close_session(&info.session_id).await;
}

/// Issue #146: switching from a reasoning model to one that advertises NO
/// thinking levels must CLEAR the previous model's level. The level is
/// sent as `reasoning_effort` on every request, so a stale one reaches a
/// model that does not accept it and the request errors.
#[tokio::test]
async fn a_native_model_switch_to_a_model_without_levels_clears_the_level() {
    let catalog = ModelCatalog {
        models: vec![
            level_test_model("tama", "a", &["off", "high"]),
            // No advertised levels: a non-reasoning model.
            level_test_model("tama", "plain", &[]),
        ],
        default_model: Some("tama/a".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    write_settings_json(&dir, serde_json::json!({}));
    let (manager, info) = start_native_session_with_catalog(&dir, &sink, catalog).await;
    let _ = manager
        .set_config_option(&info.session_id, "thought_level", "high", &sink)
        .await
        .expect("the level change applies");
    let _ = manager
        .set_config_option(&info.session_id, "model", "tama/plain", &sink)
        .await
        .expect("the model switch applies");
    // The session's mirrored level must not survive onto a model that
    // advertises no levels.
    let state = manager
        .with_session(&info.session_id, |s| s.config_state.clone())
        .flatten()
        .expect("the session is live");
    assert_eq!(
        state.thinking_level, None,
        "a model with no levels must not keep the previous model's level"
    );
    let _ = manager.close_session(&info.session_id).await;
}

/// Issue #146: switching to a model that DOES advertise levels, but has no
/// remembered level and does not accept the current one, resets to `None`
/// (the model's default). That reset must reach the worker as a CLEAR, not
/// be dropped as "leave alone".
#[tokio::test]
async fn a_native_model_switch_with_no_memory_clears_an_invalid_level() {
    let catalog = ModelCatalog {
        models: vec![
            level_test_model("tama", "a", &["off", "high"]),
            level_test_model("tama", "d", &["off", "low", "medium"]),
        ],
        default_model: Some("tama/a".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    write_settings_json(&dir, serde_json::json!({}));
    let (manager, info) = start_native_session_with_catalog(&dir, &sink, catalog).await;
    let _ = manager
        .set_config_option(&info.session_id, "thought_level", "high", &sink)
        .await
        .expect("the level change applies");
    let updated = manager
        .set_config_option(&info.session_id, "model", "tama/d", &sink)
        .await
        .expect("the model switch applies");
    // No memory for `d` → the level is cleared, not kept as "high".
    let state = manager
        .with_session(&info.session_id, |s| s.config_state.clone())
        .flatten()
        .expect("the session is live");
    assert_eq!(
        state.thinking_level, None,
        "an invalid level with no remembered replacement resets to None"
    );
    let thought = updated
        .iter()
        .find(|o| o["id"] == "thought_level")
        .expect("a thought_level selector");
    assert_ne!(
        thought["currentValue"], "high",
        "the stale level must not be reported as current"
    );
    let _ = manager.close_session(&info.session_id).await;
}

/// (ADR 0015) The flip side: a current level that IS a member of the
/// new model's `thinking_levels` is KEPT across the switch (minimal
/// surprise — no reset).
#[tokio::test]
async fn a_native_model_switch_keeps_a_valid_level() {
    let catalog = ModelCatalog {
        models: vec![
            level_test_model("tama", "a", &["off", "high"]),
            level_test_model("tama", "c", &["off", "high", "medium"]),
        ],
        default_model: Some("tama/a".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    write_settings_json(&dir, serde_json::json!({}));
    let (manager, info) = start_native_session_with_catalog(&dir, &sink, catalog).await;
    let _ = manager
        .set_config_option(&info.session_id, "thought_level", "high", &sink)
        .await
        .expect("the level change applies");
    let updated = manager
        .set_config_option(&info.session_id, "model", "tama/c", &sink)
        .await
        .expect("the model switch applies");
    let thought = updated
        .iter()
        .find(|o| o["id"] == "thought_level")
        .expect("a thought_level selector");
    assert_eq!(
        thought["currentValue"], "high",
        "a valid level is kept across the switch"
    );
    let _ = manager.close_session(&info.session_id).await;
}

/// A mid-session model switch persists the new model key and re-synthesised
/// thinkingLevel to the sessions table row, so the switch survives a restart.
#[tokio::test]
async fn a_native_model_switch_persists_model_key_and_capabilities_to_row() {
    let catalog = ModelCatalog {
        models: vec![
            level_test_model("tama", "a", &["off", "high"]),
            level_test_model("b", "gpt-4o", &["off", "low", "medium", "xhigh"]),
        ],
        default_model: Some("tama/a".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    write_settings_json(
        &dir,
        serde_json::json!({ "defaultThinkingLevels": { "b/gpt-4o": "xhigh" } }),
    );
    let (manager, _wm, db) = build_worker_manager(&dir, catalog, &sink);
    let info = manager
        .start_session(dir.to_path_buf(), &sink)
        .await
        .expect("the native session started");

    // The current level on A (valid for `a`).
    let _ = manager
        .set_config_option(&info.session_id, "thought_level", "high", &sink)
        .await
        .expect("the level change applies");

    // Switch to `b/gpt-4o`. "high" is not in b's levels, so thinking level
    // resets to b's remembered level ("xhigh").
    let _ = manager
        .set_config_option(&info.session_id, "model", "b/gpt-4o", &sink)
        .await
        .expect("the model switch applies");

    let row = db
        .session(&info.session_id)
        .expect("db.session should succeed")
        .expect("the row exists");

    let caps: serde_json::Value =
        serde_json::from_str(&row.capabilities_json).expect("valid capabilities_json");
    assert_eq!(
        caps["model"], "b/gpt-4o",
        "the persisted row must reflect the switched model key"
    );
    assert_eq!(
        caps["thinkingLevel"], "xhigh",
        "the persisted row must reflect the re-synthesised thinkingLevel for the new model"
    );

    let _ = manager.close_session(&info.session_id).await;

    // Restart/resume: the session resumes on model B because the row persisted "b/gpt-4o".
    let resumed = manager
        .resume_session(&info.session_id, dir.to_path_buf(), &sink)
        .await
        .expect("the native resume succeeded");
    assert_eq!(
        resumed.capabilities["model"], "b/gpt-4o",
        "a session switched A -> B resumes on B after a restart"
    );
    let _ = manager.close_session(&info.session_id).await;
}

/// (ADR 0015) Native resume: the remembered level (VALIDATED) wins over
/// the STORED `thinkingLevel` (the start-of-session value — stale after
/// a mid-session change), which wins over the harness seed.
#[tokio::test]
async fn a_resume_prefers_the_remembered_level_over_the_stale_stored_value() {
    let catalog = ModelCatalog {
        models: vec![level_test_model(
            "tama",
            "m1",
            &["off", "low", "high", "xhigh"],
        )],
        default_model: Some("tama/m1".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    write_settings_json(
        &dir,
        serde_json::json!({ "defaultThinkingLevels": { "tama/m1": "xhigh" } }),
    );
    let (manager, _wm, db) = build_worker_manager(&dir, catalog, &sink);
    // The stored row: the start-of-session level (`"high"` — valid for
    // the model; a mid-session change to `xhigh` is only in the memory).
    db.record_session(&SessionInfo {
        session_id: "nat-resume-1".to_string(),
        cwd: dir.to_path_buf(),
        capabilities: json!({
            "native": true,
            "model": "tama/m1",
            "thinkingLevel": "high",
            "loadSession": true,
        }),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    })
    .expect("record_session should succeed");
    let info = manager
        .resume_session("nat-resume-1", dir.to_path_buf(), &sink)
        .await
        .expect("the native resume works");
    assert_eq!(
        info.capabilities["thinkingLevel"], "xhigh",
        "memory wins over the stale stored value"
    );
    let _ = manager.close_session(&info.session_id).await;
}

/// `list_sessions` carries the stored session's `config_options`
/// (synthesized from the stored `model` / `thinkingLevel` — the
/// frontend's `SessionConfigSelect` renders them in the stored
/// session's composer, disabled) and `context_usage` (persisted via
/// `record_session_context_usage` — the frontend's store drops it on
/// close, so the row is the source of truth for the stored session's
/// context bar).
#[tokio::test]
async fn list_sessions_carries_the_stored_config_options_and_context_usage() {
    let catalog = ModelCatalog {
        models: vec![level_test_model(
            "tama",
            "m1",
            &["off", "low", "high", "xhigh"],
        )],
        default_model: Some("tama/m1".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let dir = temp_config_dir();
    let db = open_db(&dir);
    let mut manager = SessionManager::new(dir.to_path_buf());
    manager.attach_db(db.clone());
    manager.set_catalog(catalog);
    // The stored row: the start-of-session `model` / `thinkingLevel`
    // (the `capabilities` envelope) + a persisted context usage.
    db.record_session(&SessionInfo {
        session_id: "nat-list-1".to_string(),
        cwd: dir.to_path_buf(),
        capabilities: json!({
            "native": true,
            "model": "tama/m1",
            "thinkingLevel": "high",
            "loadSession": true,
        }),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    })
    .expect("record_session should succeed");
    db.record_session_context_usage("nat-list-1", 53_760, 128_000)
        .expect("record_session_context_usage should succeed");
    let rows = manager
        .list_sessions(true)
        .await
        .expect("list_sessions should work");
    assert_eq!(rows.len(), 1, "the stored row is listed");
    let row = &rows[0];
    // `config_options`: the model selector (current value = the stored
    // composed key) + the thinking-level selector (current value = the
    // stored level).
    let options = row
        .config_options
        .as_ref()
        .expect("config_options are synthesized for the stored session");
    let model = options
        .iter()
        .find(|o| o["id"] == "model")
        .expect("the model option");
    assert_eq!(model["currentValue"], "tama/m1");
    assert!(
        model["options"]
            .as_array()
            .unwrap()
            .iter()
            .any(|o| o["value"] == "tama/m1"),
        "the stored model is in the options list"
    );
    let thinking = options
        .iter()
        .find(|o| o["id"] == "thought_level")
        .expect("the thinking-level option");
    assert_eq!(thinking["currentValue"], "high");
    // `context_usage`: the persisted last-known usage.
    let usage = row
        .context_usage
        .as_ref()
        .expect("context_usage is carried from the row");
    assert_eq!(usage.used, 53_760);
    assert_eq!(usage.window, 128_000);
}

/// (#85) A stored session's `context_usage.window` is DERIVED from the model
/// the row's `capabilities.model` resolves to, not replayed from the
/// `context_usage_json` snapshot.
///
/// The snapshot's `window` is a fact about the MODEL, frozen when the frame
/// was written — so after a provider's metadata is corrected it is simply
/// wrong, and it stays wrong for every closed session. `used` is a genuine
/// measurement of that session and is replayed as-is.
///
/// The fallback is load-bearing: a row whose model key no longer resolves
/// (the provider was removed, the model renamed) keeps its snapshot, because
/// the snapshot is then the only window anyone knows.
#[tokio::test]
async fn a_stored_sessions_context_window_follows_the_current_catalog() {
    let catalog = ModelCatalog {
        models: vec![level_test_model("tama", "m1", &[])],
        default_model: Some("tama/m1".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let dir = temp_config_dir();
    let db = open_db(&dir);
    let mut manager = SessionManager::new(dir.to_path_buf());
    manager.attach_db(db.clone());
    manager.set_catalog(catalog);
    // The row ran `tama/m1` when the catalog said 128k, so that is the
    // snapshot written with the usage.
    db.record_session(&SessionInfo {
        session_id: "cu-derive-1".to_string(),
        cwd: dir.to_path_buf(),
        capabilities: json!({
            "native": true,
            "model": "tama/m1",
            "loadSession": true,
        }),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    })
    .expect("record_session should succeed");
    db.record_session_context_usage("cu-derive-1", 53_760, 128_000)
        .expect("record_session_context_usage should succeed");
    // The provider's metadata is CORRECTED: the model is now 1M.
    manager.set_catalog(ModelCatalog {
        models: vec![Model {
            context_window: 1_000_000,
            ..level_test_model("tama", "m1", &[])
        }],
        default_model: Some("tama/m1".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    });
    let rows = manager
        .list_sessions(true)
        .await
        .expect("list_sessions works");
    let usage = rows[0]
        .context_usage
        .as_ref()
        .expect("context_usage is still carried");
    assert_eq!(
        usage.window, 1_000_000,
        "the window is DERIVED from the resolved model (#85) — a closed \
         session must not keep the stale window its snapshot froze"
    );
    assert_eq!(
        usage.used, 53_760,
        "`used` is a real measurement of the session — replayed, never re-derived"
    );
}

/// (#85) The fallback half: a row whose `capabilities.model` no longer
/// resolves keeps its snapshot window (the only window anyone knows).
#[tokio::test]
async fn a_stored_session_with_an_unresolvable_model_keeps_its_snapshot_window() {
    let catalog = ModelCatalog {
        models: vec![level_test_model("tama", "m1", &[])],
        default_model: Some("tama/m1".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let dir = temp_config_dir();
    let db = open_db(&dir);
    let mut manager = SessionManager::new(dir.to_path_buf());
    manager.attach_db(db.clone());
    manager.set_catalog(catalog);
    // A model key the catalog does not know (the provider was removed).
    db.record_session(&SessionInfo {
        session_id: "cu-derive-gone".to_string(),
        cwd: dir.to_path_buf(),
        capabilities: json!({
            "native": true,
            "model": "gone/model",
            "loadSession": true,
        }),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    })
    .expect("record_session should succeed");
    db.record_session_context_usage("cu-derive-gone", 1_000, 640_000)
        .expect("record_session_context_usage should succeed");
    let rows = manager
        .list_sessions(true)
        .await
        .expect("list_sessions works");
    let usage = rows[0]
        .context_usage
        .as_ref()
        .expect("context_usage is carried");
    assert_eq!(
        usage.window, 640_000,
        "an unresolvable model keeps the snapshot — it is the only window known"
    );
}

/// `list_sessions` carries the stored `title` (the naming pass's
/// generated label — the sidebar renders it), and a session with no
/// title yet carries `None` (NOT the empty string: the frontend renders
/// the fallback label from the absence).
#[tokio::test]
async fn list_sessions_carries_the_stored_title() {
    let catalog = ModelCatalog {
        models: vec![level_test_model(
            "tama",
            "m1",
            &["off", "low", "high", "xhigh"],
        )],
        default_model: Some("tama/m1".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let dir = temp_config_dir();
    let db = open_db(&dir);
    let mut manager = SessionManager::new(dir.to_path_buf());
    manager.attach_db(db.clone());
    manager.set_catalog(catalog);
    for id in ["nat-titled-1", "nat-untitled-2"] {
        db.record_session(&SessionInfo {
            session_id: id.to_string(),
            cwd: dir.to_path_buf(),
            capabilities: json!({
                "native": true,
                "model": "tama/m1",
                "loadSession": true,
            }),
            config_options: None,
            archived: false,
            title: None,
            context_usage: None,
            cost_usd: None,
            is_subagent: false,
        })
        .expect("record_session should succeed");
    }
    // Only ONE of them is titled (the naming pass ran for that session).
    db.set_session_title("nat-titled-1", "Rename the persist seam")
        .expect("set_session_title should succeed");
    let rows = manager
        .list_sessions(true)
        .await
        .expect("list_sessions should work");
    assert_eq!(rows.len(), 2, "both stored rows are listed");
    let by_id: std::collections::HashMap<&str, Option<&str>> = rows
        .iter()
        .map(|r| (r.session_id.as_str(), r.title.as_deref()))
        .collect();
    assert_eq!(
        by_id["nat-titled-1"],
        Some("Rename the persist seam"),
        "the stored title crosses the IPC boundary"
    );
    assert_eq!(
        by_id["nat-untitled-2"], None,
        "an untitled stored row carries None"
    );
}

/// A resume carries the stored `context_usage` (the last known before
/// the close — the `load_transcript` re-estimate's first frame
/// refreshes it after the resume).
#[tokio::test]
async fn a_resume_carries_the_stored_context_usage() {
    let catalog = ModelCatalog {
        models: vec![level_test_model(
            "tama",
            "m1",
            &["off", "low", "high", "xhigh"],
        )],
        default_model: Some("tama/m1".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, _wm, db) = build_worker_manager(&dir, catalog, &sink);
    db.record_session(&SessionInfo {
        session_id: "nat-resume-cu-1".to_string(),
        cwd: dir.to_path_buf(),
        capabilities: json!({
            "native": true,
            "model": "tama/m1",
            "loadSession": true,
        }),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    })
    .expect("record_session should succeed");
    db.record_session_context_usage("nat-resume-cu-1", 96_000, 128_000)
        .expect("record_session_context_usage should succeed");
    let info = manager
        .resume_session("nat-resume-cu-1", dir.to_path_buf(), &sink)
        .await
        .expect("the native resume works");
    let usage = info
        .context_usage
        .expect("the resume carries the stored context usage");
    assert_eq!(usage.used, 96_000);
    assert_eq!(usage.window, 128_000);
    let _ = manager.close_session(&info.session_id).await;
}

/// (settings chain) the native model resolution chain: the
/// `Settings.default_model` (a fresh `load_settings` read) > the
/// catalog's `default_model` > the selectable set. An UNRESOLVABLE key
/// at any rung falls through to the NEXT rung.
#[tokio::test]
async fn the_native_model_chain_settings_default_wins_over_the_catalog_default() {
    let catalog = ModelCatalog {
        models: vec![
            chain_test_model("s", "m1"),
            chain_test_model("c", "m2"),
            chain_test_model("h", "m3"),
        ],
        default_model: Some("c/m2".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });

    // Phase 1: settings `s/m1` (in the catalog) → the settings rung
    // wins over the catalog default.
    write_settings_default_model(&dir, Some("s/m1"));
    let (manager, _wm, _db) = build_worker_manager(&dir, catalog.clone(), &sink);
    let info = manager
        .start_session(dir.to_path_buf(), &sink)
        .await
        .expect("the native session started");
    assert_eq!(
        info.capabilities["model"], "s/m1",
        "the settings default wins over the catalog default"
    );
    let _ = manager.close_session(&info.session_id).await;

    // Phase 2: settings `gone/m1` (NOT in the catalog) → the
    // unresolvable settings key falls through to the CATALOG DEFAULT
    // rung (not straight to the selectable set).
    write_settings_default_model(&dir, Some("gone/m1"));
    let (manager, _wm, _db) = build_worker_manager(&dir, catalog.clone(), &sink);
    let info = manager
        .start_session(dir.to_path_buf(), &sink)
        .await
        .expect("the native session started");
    assert_eq!(
        info.capabilities["model"], "c/m2",
        "an unresolvable settings key degrades to the catalog default"
    );
    let _ = manager.close_session(&info.session_id).await;

    // Phase 3: NO settings default → the catalog default applies.
    write_settings_default_model(&dir, None);
    let (manager, _wm, _db) = build_worker_manager(&dir, catalog.clone(), &sink);
    let info = manager
        .start_session(dir.to_path_buf(), &sink)
        .await
        .expect("the native session started");
    assert_eq!(
        info.capabilities["model"], "c/m2",
        "an absent settings default degrades to the catalog default"
    );
    let _ = manager.close_session(&info.session_id).await;
}

// ── `refresh_live_credentials` (issue #125 — the credential push) ──

/// The credential push reaches the LIVE session: the `config_state` mirror's
/// model carries the new bearer. This is the sibling of
/// `refresh_live_models` (which refuses to copy `api_key` — that refusal is
/// pinned by its own tests), so the two push paths are pinned separately.
///
/// The mirror is the load-bearing assertion (the interface §6 note): the
/// Worker-side application is `AgentLoop::set_model`, already pinned by the
/// loop's own `set_model` test.
#[tokio::test]
async fn refresh_live_credentials_pushes_the_new_bearer_to_live_session_models() {
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, _wm, _db) = build_worker_manager(&dir, native_test_catalog(), &sink);
    let info = manager
        .start_session(dir.to_path_buf(), &sink)
        .await
        .expect("the native session started");
    // The premise: the live session runs `fake/m1` with the catalog's static
    // key.
    let before = manager
        .with_session(&info.session_id, |s| s.config_state.clone())
        .flatten()
        .expect("the session is live");
    assert_eq!(before.model.provider, "fake");
    assert_eq!(before.model.api_key, "k", "the static key from the catalog");

    let pushed = manager.refresh_live_credentials("fake", "new-bearer").await;
    assert_eq!(pushed, 1, "the one live session on `fake` was pushed");

    let after = manager
        .with_session(&info.session_id, |s| s.config_state.clone())
        .flatten()
        .expect("the session is still live");
    assert_eq!(
        after.model.api_key, "new-bearer",
        "the mirror carries the new bearer"
    );
    // The sibling's contract: ONLY the key changes — the context window and
    // the thinking fields are the session's own, untouched by a credential
    // push (that is why this is a separate method from `refresh_live_models`).
    assert_eq!(after.model.context_window, before.model.context_window);
    assert_eq!(
        after.model.supports_thinking,
        before.model.supports_thinking
    );
    assert_eq!(after.model.id, before.model.id);
    assert_eq!(after.model.base_url, before.model.base_url);
    assert_eq!(
        after.thinking_level, before.thinking_level,
        "a credential push never touches the thinking level"
    );
    let _ = manager.close_session(&info.session_id).await;
}

/// Scoping is per provider: a session whose current model is on another
/// provider is never touched by a push for `fake` (pushing a foreign bearer
/// into another provider's session would break a working session).
#[tokio::test]
async fn refresh_live_credentials_updates_only_the_matching_provider() {
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    // Two providers in the catalog; the session runs `other/m2`.
    let catalog = ModelCatalog {
        models: vec![
            chain_test_model("fake", "m1"),
            chain_test_model("other", "m2"),
        ],
        default_model: Some("other/m2".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let (manager, _wm, _db) = build_worker_manager(&dir, catalog, &sink);
    let info = manager
        .start_session(dir.to_path_buf(), &sink)
        .await
        .expect("the native session started");
    assert_eq!(
        info.capabilities["model"], "other/m2",
        "the session runs the OTHER provider's model"
    );

    let pushed = manager.refresh_live_credentials("fake", "new-bearer").await;
    assert_eq!(pushed, 0, "no session runs on `fake`");
    let state = manager
        .with_session(&info.session_id, |s| s.config_state.clone())
        .flatten()
        .expect("the session is live");
    assert_eq!(
        state.model.api_key, "k",
        "the other provider's session keeps its own key"
    );

    // And the same call for the provider it DOES run on pushes exactly that
    // session — the filter matches, it is not simply always-empty.
    let pushed = manager
        .refresh_live_credentials("other", "new-bearer")
        .await;
    assert_eq!(pushed, 1, "the matching provider's session was pushed");
    let state = manager
        .with_session(&info.session_id, |s| s.config_state.clone())
        .flatten()
        .expect("the session is live");
    assert_eq!(state.model.api_key, "new-bearer");
    let _ = manager.close_session(&info.session_id).await;
}

/// The no-op guard: pushing the key the session ALREADY has sends nothing
/// (a `set_model` rebuilds the `Compactor`, re-estimates, emits a
/// `context_usage_update` and writes the `sessions` row — firing it on an
/// unchanged key would be a frame and a DB write for nothing, the same
/// reasoning `refresh_live_models`' gate encodes).
#[tokio::test]
async fn refresh_live_credentials_skips_unchanged_keys() {
    let dir = temp_config_dir();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, _wm, _db) = build_worker_manager(&dir, native_test_catalog(), &sink);
    let info = manager
        .start_session(dir.to_path_buf(), &sink)
        .await
        .expect("the native session started");

    // The SAME key the live model already carries.
    let pushed = manager.refresh_live_credentials("fake", "k").await;
    assert_eq!(pushed, 0, "an unchanged key pushes nothing");
    let state = manager
        .with_session(&info.session_id, |s| s.config_state.clone())
        .flatten()
        .expect("the session is live");
    assert_eq!(state.model.api_key, "k", "and the mirror is untouched");
    assert!(
        rx.try_recv().is_err(),
        "no event was emitted for a no-op push"
    );
    let _ = manager.close_session(&info.session_id).await;
}

/// No live sessions at all → `0` (the refresher loop calls this after every
/// successful refresh, so the empty case is the common one and must be free
/// rather than an error).
#[tokio::test]
async fn refresh_live_credentials_with_no_live_sessions_returns_zero() {
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, _wm, _db) = build_worker_manager(&dir, native_test_catalog(), &sink);
    // No session started at all.
    assert_eq!(
        manager.refresh_live_credentials("fake", "new-bearer").await,
        0,
        "no live sessions ⇒ nothing pushed, no error"
    );
    // And a session that has been CLOSED is not a target either: its Worker
    // is gone, so the push is skipped (best-effort per session, exactly like
    // `refresh_live_models`).
    let info = manager
        .start_session(dir.to_path_buf(), &sink)
        .await
        .expect("the native session started");
    let _ = manager.close_session(&info.session_id).await;
    assert_eq!(
        manager.refresh_live_credentials("fake", "new-bearer").await,
        0,
        "a closed session's Worker is gone, so nothing is pushed to it"
    );
}

/// (live `/v1/models` discovery) `refresh_model_metadata` applies the
/// live metadata (context window, thinking levels) from the provider's
/// `GET /v1/models`, and degrades to the static metadata when the
/// endpoint is unreachable (best-effort — a failure never blocks the
/// session).
#[tokio::test]
async fn refresh_model_metadata_applies_live_and_degrades_on_failure() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    // A mock server serving `GET /v1/models` with fresh metadata.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let mut data = Vec::new();
                while !data.windows(4).any(|w| w == b"\r\n\r\n") {
                    let Ok(n) = stream.read(&mut buf).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    data.extend_from_slice(&buf[..n]);
                }
                let body = r#"{"data":[{"id":"m1","max_model_len":4242,
                        "reasoningLevels":["low"],
                        "supportsReasoningEffort":true}]}"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes()).await;
            });
        }
    });
    let dir = crate::test_support::ScratchDir::in_env_temp("refresh-", "metadata");
    let mut manager = SessionManager::new(dir.to_path_buf());
    manager.set_catalog(ModelCatalog {
        models: vec![Model {
            id: "m1".into(),
            provider: "fake".into(),
            base_url: format!("http://{addr}/v1"),
            api_key: "k".into(),
            context_window: 128000,
            cost_per_mtok_in: 0.0,
            cost_per_mtok_out: 0.0,
            supports_tools: true,
            supports_thinking: false,
            thinking_levels: Vec::new(),
            api: Some("openai-completions".into()),
        }],
        ..Default::default()
    });
    let model = manager.catalog.clone().models[0].clone();
    // First refresh: fetches + applies the live metadata.
    let refreshed = manager.refresh_model_metadata(&model).await;
    assert_eq!(refreshed.context_window, 4242);
    assert_eq!(refreshed.thinking_levels, vec!["low".to_string()]);
    assert!(refreshed.supports_thinking);
    // The `api_key` / `base_url` / `id` are untouched (only the metadata
    // fields are refreshed).
    assert_eq!(refreshed.api_key, "k");
    assert_eq!(refreshed.base_url, model.base_url);
    // A model whose endpoint is UNREACHABLE degrades to the static
    // metadata (the `Model` is returned unchanged — best-effort). A
    // distinct `provider` (a fresh cache entry) so the unreachable
    // endpoint is actually fetched (not the first model's warm cache).
    let unreachable = Model {
        provider: "unreach".to_string(),
        base_url: "http://127.0.0.1:1/v1".to_string(),
        ..model.clone()
    };
    let degraded = manager.refresh_model_metadata(&unreachable).await;
    assert_eq!(degraded.context_window, 128000);
    assert!(!degraded.supports_thinking);
    server.abort();
}

// ── issue #129: the resolve spine (bearer, headers, the HTTP gate) ──────

/// `PERPLEXITY_API_KEY`-style restore guard (the `commands/settings.rs` /
/// `agent/web/config.rs` pattern — the restore happens even when an
/// assertion panics). Caller must hold `env_lock()`.
struct RestoreEnv(&'static str, Option<std::ffi::OsString>);
impl Drop for RestoreEnv {
    fn drop(&mut self) {
        match self.1.take() {
            // SAFETY: the `ENV_LOCK` is still held at drop time (this guard
            // is declared after the `_lock` guard and outlives it in
            // reverse); no other thread mutates the env concurrently.
            Some(v) => unsafe { std::env::set_var(self.0, v) },
            None => unsafe { std::env::remove_var(self.0) },
        }
    }
}

/// Unset `key` for the rest of the test. Caller must hold `env_lock()` (the
/// `commands/settings.rs` helper of the same name).
fn remove_env(key: &'static str) -> RestoreEnv {
    let prev = std::env::var_os(key);
    // SAFETY: `ENV_LOCK` is held by the caller.
    unsafe { std::env::remove_var(key) };
    RestoreEnv(key, prev)
}

/// Set `key` for the rest of the test. Caller must hold `env_lock()`.
fn set_env(key: &'static str, value: &str) -> RestoreEnv {
    let prev = std::env::var_os(key);
    // SAFETY: `ENV_LOCK` is held by caller.
    unsafe { std::env::set_var(key, value) };
    RestoreEnv(key, prev)
}

/// Restores the global debug log to DISABLED on scope exit (the
/// `commands/sessions.rs` guard — a panic must not hand a sibling test a
/// global pointing at this test's deleted scratch dir).
struct DisableDebuglogOnExit;
impl Drop for DisableDebuglogOnExit {
    fn drop(&mut self) {
        crate::agent::debuglog::init(false, None);
    }
}

/// A `settings.json` with ONE provider written from a JSON value (the
/// issue-#129 fixtures need per-row `headers` / `allowInsecureHttp` /
/// `apiKey`, which the two fixed-shape helpers above cannot express).
fn write_settings_provider_row(dir: &Path, row: Value) {
    std::fs::write(
        dir.join("settings.json"),
        serde_json::to_string_pretty(&json!({ "providers": [row] })).unwrap(),
    )
    .unwrap();
}

/// A raw `GET /v1/models` server that CAPTURES each request's header block
/// and serves one model list. The capture is what lets a test assert what
/// actually went on the WIRE (the shared `test_support::raw_json_server`
/// ignores request headers — documented there).
async fn capturing_models_server(
    body: &'static str,
) -> (
    std::net::SocketAddr,
    tokio::task::JoinHandle<()>,
    tokio::sync::mpsc::Receiver<String>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (tx, rx) = tokio::sync::mpsc::channel::<String>(16);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("the listener binds");
    let addr = listener.local_addr().expect("an address");
    let server = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let mut data = Vec::new();
                while !data.windows(4).any(|w| w == b"\r\n\r\n") {
                    let Ok(n) = stream.read(&mut buf).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    data.extend_from_slice(&buf[..n]);
                }
                let head = String::from_utf8_lossy(&data).to_string();
                let _ = tx.send(head).await;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes()).await;
            });
        }
    });
    (addr, server, rx)
}

/// (issue #129) A `!command` `api_key` is EXECUTED at resolve time and the
/// resulting bearer reaches BOTH the discovery request (`Authorization:
/// Bearer tok`) and every `Model` row — the substitution happens BEFORE
/// discovery, not only in the row (grounding §2).
#[cfg(unix)]
#[tokio::test]
async fn resolve_substitutes_a_key_helper_bearer_into_models_and_discovery() {
    let dir = temp_config_dir();
    let (addr, server, mut rx) = capturing_models_server(r#"{"data":[{"id":"m/1"}]}"#).await;
    write_settings_provider_row(
        &dir,
        json!({
            "id": "tama", "name": "tama",
            "baseUrl": format!("http://{addr}/v1"),
            "apiKey": "!echo tok"
        }),
    );
    let mut manager = SessionManager::new(dir.to_path_buf());
    manager.set_catalog(ModelCatalog::default());
    let effective = manager.effective_catalog(None, true).await;
    let row = effective
        .models
        .iter()
        .find(|m| m.id == "m/1")
        .expect("the discovered model is in the effective catalog");
    assert_eq!(
        row.api_key, "tok",
        "the helper's stdout (trimmed) is the row's key"
    );
    let head = rx.recv().await.expect("the server saw the request");
    assert!(
        head.to_lowercase().contains("authorization: bearer tok"),
        "discovery must carry the SUBSTITUTED bearer:\n{head}"
    );
    server.abort();
}

/// (issue #128) The ADC bearer reaches BOTH the discovery request and every
/// `Model` row: `resolve` resolves the bearer BEFORE `discover_models`, so a
/// gateway whose `/model/info` needs the Google token is discovered with it
/// (grounding §2 — the substitution is not row-only).
///
/// Hermeticity: the ADC file is a scratch fixture and the token endpoint a
/// `wiremock` URL, installed through `gcloud`'s test-override seam — which
/// REPLACES discovery, so the developer's real `~/.config/gcloud` file is
/// unreachable from here and no request can reach real Google. The override
/// and the token cache are process-global, so `ENV_LOCK` is held for the whole
/// span (the `set_env` tests' precedent).
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn resolve_substitutes_the_gcloud_adc_bearer_into_models_and_discovery() {
    use wiremock::matchers::method;
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let _lock = crate::test_support::env_lock();
    crate::agent::provider_auth::gcloud::cache_clear();
    let adc = ScratchDir::in_env_temp("-t4-adc", "fixture");
    let adc_file = adc.join("application_default_credentials.json");
    std::fs::write(
        &adc_file,
        json!({
            "type": "authorized_user",
            "client_id": "session-test-client",
            "client_secret": "session-test-secret",
            "refresh_token": format!("session-test-refresh-{}", uuid::Uuid::new_v4())
        })
        .to_string(),
    )
    .unwrap();
    let token_server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"access_token": "ya29.minted"})),
        )
        .mount(&token_server)
        .await;
    let _override = crate::agent::provider_auth::gcloud::set_test_adc_override(
        crate::agent::provider_auth::gcloud::TestAdcOverride {
            adc_file: crate::agent::provider_auth::gcloud::AdcFileSource::Explicit(Some(
                adc_file.clone(),
            )),
            token_endpoint: Some(token_server.uri()),
        },
    );

    let dir = temp_config_dir();
    let (addr, server, mut rx) = capturing_models_server(r#"{"data":[{"id":"m/1"}]}"#).await;
    write_settings_provider_row(
        &dir,
        json!({
            "id": "tama", "name": "tama",
            "baseUrl": format!("http://{addr}/v1"),
            "apiKey": "static-key",
            "useGcloudTokenAuth": true
        }),
    );
    let mut manager = SessionManager::new(dir.to_path_buf());
    manager.set_catalog(ModelCatalog::default());
    let effective = manager.effective_catalog(None, true).await;
    let row = effective
        .models
        .iter()
        .find(|m| m.id == "m/1")
        .expect("the discovered model is in the effective catalog");
    assert_eq!(
        row.api_key, "ya29.minted",
        "the minted ADC token REPLACES the row's static key"
    );
    let head = rx.recv().await.expect("the server saw the request");
    assert!(
        head.to_lowercase()
            .contains("authorization: bearer ya29.minted"),
        "discovery must carry the SUBSTITUTED ADC bearer:\n{head}"
    );
    server.abort();
    // The mint went to the in-memory cache and nowhere else — the on-disk
    // store's untouched-ness is pinned from the outside by
    // `minting_a_token_never_writes_the_provider_auth_store`.
    assert!(
        !dir.join("provider-auth.json").exists(),
        "the ADC path writes nothing into the config dir"
    );
}

/// (issue #128) The env precedence TABLE, at the function that computes it
/// (`provider_auth::gcloud_token_auth_enabled`, called by the `gcloud_adc`
/// arm): `=1` forces the flow on for a row that did not ask, `=0`/`=false`
/// refuses it for a row that did, unset or an unrecognised value defers to the
/// row.
///
/// Deliberately asserted HERE rather than through four more resolves: the
/// resolve spine substitutes whatever the arm returns (pinned by
/// `resolve_substitutes_the_gcloud_adc_bearer_into_models_and_discovery`), the
/// env is read at the arm and nowhere else, and driving four extra raw
/// discovery servers in the parallel suite buys no new claim.
#[allow(clippy::await_holding_lock)] // the env is process-global
#[test]
fn the_gcloud_env_override_beats_the_provider_flag() {
    use crate::agent::provider_auth::gcloud_token_auth_enabled;

    let _lock = crate::test_support::env_lock();
    let row = |mode: &str, flag: bool| crate::config::ProviderConfig {
        id: "gw".to_string(),
        name: "Gateway".to_string(),
        base_url: "https://gw.example/v1".to_string(),
        api_key: "k".to_string(),
        api: "litellm".to_string(),
        key_url: None,
        auth_mode: mode.to_string(),
        headers: None,
        allow_insecure_http: false,
        use_gcloud_token_auth: flag,
        // (issue #127) The mechanical additive grow: no OIDC login on this fixture.
        oidc: None,
    };

    // Unset → the row decides.
    let _unset = remove_env("LITELLM_GCLOUD_TOKEN_AUTH");
    assert!(gcloud_token_auth_enabled(&row("gcloud_adc", false)));
    assert!(gcloud_token_auth_enabled(&row("api_key", true)));
    assert!(!gcloud_token_auth_enabled(&row("api_key", false)));

    // `=1` / `=true` → on for EVERY row (an env force beats a config that did
    // not opt in — the container shape, where the ADC file is the only key).
    for value in ["1", "true", "TRUE"] {
        let _on = set_env("LITELLM_GCLOUD_TOKEN_AUTH", value);
        assert!(
            gcloud_token_auth_enabled(&row("api_key", false)),
            "`{value}` must enable the flow for a row that did not ask"
        );
    }

    // `=0` / `=false` → off even for a row that opted in (the "never read my
    // ADC file" escape hatch).
    for value in ["0", "false", "FALSE"] {
        let _off = set_env("LITELLM_GCLOUD_TOKEN_AUTH", value);
        assert!(
            !gcloud_token_auth_enabled(&row("gcloud_adc", true)),
            "`{value}` must refuse the flow even for an opted-in row"
        );
    }

    // An unrecognised value → the row decides (a typo in the env must not
    // silently disable a flow the user configured).
    let _typo = set_env("LITELLM_GCLOUD_TOKEN_AUTH", "yes-please");
    assert!(gcloud_token_auth_enabled(&row("api_key", true)));
    assert!(!gcloud_token_auth_enabled(&row("api_key", false)));
}

/// (issue #129) The seeding gate: with `execute_helpers == false` the
/// invariant). The probe is a real side effect — a bare `touch <marker>` is
/// legal argv (`touch` is the program, the marker path an ordinary
/// argument), so the marker's ABSENCE proves no child ran, and the row keeps
/// the literal command string as its static key.
#[cfg(unix)]
#[tokio::test]
async fn resolve_with_execute_helpers_false_never_executes_the_helper() {
    let dir = temp_config_dir();
    // The marker lives in its OWN scratch dir (ADR 0078 — dash prefix, no
    // dot, removed on drop).
    let probe = ScratchDir::in_env_temp("-t2a-seed", "marker");
    let marker = probe.path().join("helper-ran");
    let (addr, server, _rx) = capturing_models_server(r#"{"data":[{"id":"m/1"}]}"#).await;
    write_settings_provider_row(
        &dir,
        json!({
            "id": "tama", "name": "tama",
            "baseUrl": format!("http://{addr}/v1"),
            "apiKey": format!("!touch {}", marker.display())
        }),
    );
    let mut manager = SessionManager::new(dir.to_path_buf());
    manager.set_catalog(ModelCatalog::default());
    let effective = manager.effective_catalog(None, false).await;
    let row = effective
        .models
        .iter()
        .find(|m| m.id == "m/1")
        .expect("discovery still happened (the row serves its static key)");
    assert!(
        !marker.exists(),
        "`execute_helpers = false` must NOT spawn the helper: {}",
        marker.display()
    );
    assert_eq!(
        row.api_key,
        format!("!touch {}", marker.display()),
        "the un-executed command string stays the static key (degrade, never blank)"
    );
    server.abort();
}

/// (issue #129) A provider's custom headers are expanded (`$VAR` against
/// the process environment) and attached to the DISCOVERY request.
///
/// The `#[allow(clippy::await_holding_lock)]` is INTENTIONAL (the
/// `commands/settings.rs` precedent): the env must stay set for the WHOLE
/// resolve, so the `ENV_LOCK` is held across the discovery `await`s — a
/// sibling test mutating the same var mid-resolve would make the assertion
/// depend on the scheduler.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn resolve_applies_custom_headers_to_discovery() {
    let _lock = crate::test_support::env_lock();
    let _env = set_env("T2_TEST_HEADER", "expanded-from-env");
    let dir = temp_config_dir();
    let (addr, server, mut rx) = capturing_models_server(r#"{"data":[{"id":"m/1"}]}"#).await;
    write_settings_provider_row(
        &dir,
        json!({
            "id": "tama", "name": "tama",
            "baseUrl": format!("http://{addr}/v1"),
            "apiKey": "k",
            "headers": { "x-env-test": "$T2_TEST_HEADER" }
        }),
    );
    let mut manager = SessionManager::new(dir.to_path_buf());
    manager.set_catalog(ModelCatalog::default());
    let effective = manager.effective_catalog(None, true).await;
    assert!(
        effective.models.iter().any(|m| m.id == "m/1"),
        "the provider discovered normally"
    );
    let head = rx.recv().await.expect("the server saw the request");
    assert!(
        head.to_lowercase()
            .contains("x-env-test: expanded-from-env"),
        "the expanded header must be on the wire:\n{head}"
    );
    server.abort();
}

/// (issue #129) The insecure-HTTP gate at the resolve level: a non-loopback
/// `http://` base with no opt-in contributes NO models, still SHADOWS its
/// id (ADR 0014 — the picker shows `unreachable` + settings, not stale rows),
/// and the refusal is logged with the descriptive `allowInsecureHttp`
/// message. No request is ever made to the plaintext endpoint.
///
/// The `#[allow(clippy::await_holding_lock)]` is INTENTIONAL: the guard holds
/// the process-global `debuglog` target (this test's own dir) for the whole
/// resolve, so a sibling's `debuglog::init` cannot repoint it mid-test (the
/// `commands/sessions.rs` precedent).
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn resolve_skips_a_provider_with_a_non_loopback_http_base() {
    let dir = temp_config_dir();
    // The log dir is this test's own (the `commands/sessions.rs` shape) so
    // the assertion never reads a sibling's lines.
    let log_dir = ScratchDir::in_env_temp("-t2a-gate", "log");
    let _lock = crate::test_support::env_lock();
    let _disable = DisableDebuglogOnExit;
    crate::agent::debuglog::init(true, Some(log_dir.to_path_buf()));

    let (_addr, server, mut rx) = capturing_models_server(r#"{"data":[{"id":"cleartext"}]}"#).await;
    // The provider is pointed at a NON-LOOPBACK literal (`10.0.0.5` — a
    // bare IP, so no DNS is involved and the refusal is deterministic).
    write_settings_provider_row(
        &dir,
        json!({
            "id": "tama", "name": "tama",
            "baseUrl": "http://10.0.0.5/v1",
            "apiKey": "k"
        }),
    );
    let mut manager = SessionManager::new(dir.to_path_buf());
    manager.set_catalog(ModelCatalog {
        models: vec![provider_model("tama/stale", "tama", "http://10.0.0.5/v1")],
        ..Default::default()
    });
    let effective = manager.effective_catalog(None, true).await;
    assert!(
        !effective.models.iter().any(|m| m.id == "cleartext"),
        "a refused base must not discover anything"
    );
    assert!(
        !effective.models.iter().any(|m| m.provider == "tama"),
        "the provider still SHADOWS its id (ADR 0014) — the stale base row \
         must not survive the gate"
    );
    assert!(
        rx.try_recv().is_err(),
        "the gate refuses BEFORE any request is sent"
    );
    let written = std::fs::read_to_string(log_dir.join("supervisor.log")).unwrap_or_default();
    assert!(
        written.contains("allowInsecureHttp"),
        "the refusal names the opt-out in the log:\n{written}"
    );
    // The SAME refusal is what the opt-in lifts — asserted at the gate level
    // in `provider_auth::headers`' own tests (a live `http://10.0.0.5`
    // request here would only prove a connect timeout, so it is not repeated).
    server.abort();
}

/// (issue #129, vet Major 1) The metadata-refresh parity is WIRED: the
/// per-session `refresh_model_metadata` fetch looks its provider row up by
/// `model.provider`, expands the row's header templates and attaches them —
/// the same header-complete request the resolve spine makes.
///
/// The `#[allow(clippy::await_holding_lock)]` is INTENTIONAL (the
/// `commands/settings.rs` precedent) — see
/// `resolve_applies_custom_headers_to_discovery` for why the env lock must
/// outlive the fetch's `await`s.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn refresh_model_metadata_sends_custom_headers() {
    let _lock = crate::test_support::env_lock();
    let _env = set_env("T2_TEST_HEADER", "metadata-parity");
    let dir = temp_config_dir();
    let (addr, server, mut rx) = capturing_models_server(
        r#"{"data":[{"id":"m1","max_model_len":4242,"reasoningLevels":["low"],
               "supportsReasoningEffort":true}]}"#,
    )
    .await;
    // The row the metadata refresh looks up (its id == the model's
    // `provider`), carrying the header TEMPLATE.
    write_settings_provider_row(
        &dir,
        json!({
            "id": "fake", "name": "fake",
            "baseUrl": format!("http://{addr}/v1"),
            "apiKey": "k",
            "headers": { "x-env-test": "$T2_TEST_HEADER" }
        }),
    );
    let mut manager = SessionManager::new(dir.to_path_buf());
    manager.set_catalog(ModelCatalog {
        models: vec![Model {
            id: "m1".into(),
            provider: "fake".into(),
            base_url: format!("http://{addr}/v1"),
            api_key: "k".into(),
            context_window: 128000,
            cost_per_mtok_in: 0.0,
            cost_per_mtok_out: 0.0,
            supports_tools: true,
            supports_thinking: false,
            thinking_levels: Vec::new(),
            api: Some("openai-completions".into()),
        }],
        ..Default::default()
    });
    let model = manager.catalog.clone().models[0].clone();
    let refreshed = manager.refresh_model_metadata(&model).await;
    // The metadata still applies (the parity is additive).
    assert_eq!(refreshed.context_window, 4242);
    let head = rx
        .recv()
        .await
        .expect("the metadata fetch reached the endpoint");
    assert!(
        head.to_lowercase().contains("x-env-test: metadata-parity"),
        "the metadata fetch must carry the expanded header:\n{head}"
    );
    server.abort();
}

/// (issue #129) The metadata refresh passes the same gate: a row whose
/// plain-HTTP non-loopback base is refused is NOT fetched at all — the
/// `Model` degrades to its static metadata (the best-effort shape the
/// unreachable endpoint already used).
#[tokio::test]
async fn refresh_model_metadata_skips_a_refused_base() {
    let dir = temp_config_dir();
    let (_addr, server, mut rx) =
        capturing_models_server(r#"{"data":[{"id":"m1","max_model_len":4242}]}"#).await;
    // The ROW's base is the refused one (the gate reads the row, which is
    // also the endpoint the model would be fetched from).
    write_settings_provider_row(
        &dir,
        json!({
            "id": "fake", "name": "fake",
            "baseUrl": "http://10.0.0.5/v1",
            "apiKey": "k"
        }),
    );
    let mut manager = SessionManager::new(dir.to_path_buf());
    manager.set_catalog(ModelCatalog {
        models: vec![provider_model("m1", "fake", "http://10.0.0.5/v1")],
        ..Default::default()
    });
    let model = manager.catalog.clone().models[0].clone();
    let refreshed = manager.refresh_model_metadata(&model).await;
    assert_eq!(
        refreshed.context_window, DEFAULT_CONTEXT_WINDOW,
        "a refused base is never fetched"
    );
    assert!(rx.try_recv().is_err(), "no request was made");
    server.abort();
}

/// Write a `settings.json` with a single user provider (the
/// `effective_catalog` tests — the desktop-owned provider store, ADR
/// 0014; the camelCase wire shape). `api` is the provider's wire API
/// (ADR 0024 — a pre-feature fixture omits the field, which parses to
/// `"openai-completions"` via the serde default).
fn write_settings_provider_api(dir: &Path, id: &str, base_url: &str, api: &str) {
    let settings = serde_json::json!({
        "providers": [
            { "id": id, "name": id, "baseUrl": base_url, "apiKey": "k", "api": api }
        ]
    });
    std::fs::write(
        dir.join("settings.json"),
        serde_json::to_string_pretty(&settings).unwrap(),
    )
    .unwrap();
}

/// Write a `settings.json` with a single user provider (the pre-feature
/// wire shape — NO `api` field; the serde default gives
/// `"openai-completions"`).
fn write_settings_provider(dir: &Path, id: &str, base_url: &str) {
    write_settings_provider_api(dir, id, base_url, "openai-completions")
}

/// A full `Model` literal (the `provider` / `base_url` are
/// parameterized — `session.rs` has no `Model` helper of its own).
fn provider_model(id: &str, provider: &str, base_url: &str) -> Model {
    Model {
        id: id.to_string(),
        provider: provider.to_string(),
        base_url: base_url.to_string(),
        api_key: "k".to_string(),
        context_window: DEFAULT_CONTEXT_WINDOW,
        cost_per_mtok_in: 0.0,
        cost_per_mtok_out: 0.0,
        supports_tools: true,
        supports_thinking: false,
        thinking_levels: Vec::new(),
        api: Some("openai-completions".to_string()),
    }
}

/// (ADR 0014) `effective_catalog` discovers a user provider's models
/// via `GET {base_url}/models` (a fresh `settings.json` read) and
/// maps them onto `Model` rows (the provider's `base_url` / `api_key`;
/// `context_window` falls back to `DEFAULT_CONTEXT_WINDOW` when the
/// response lacks `max_model_len`).
#[tokio::test]
async fn effective_catalog_discovers_a_user_provider() {
    let dir = temp_config_dir();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = crate::test_support::raw_json_server(
        listener,
        200,
        r#"{"data":[{"id":"m/1"}]}"#, // no `max_model_len` → the default window
        None,
    )
    .await;
    write_settings_provider(&dir, "tama", &format!("http://{addr}/v1"));
    // A seeded catalog under a DIFFERENT provider id (coexists — no
    // clash).
    let mut manager = SessionManager::new(dir.to_path_buf());
    manager.set_catalog(ModelCatalog {
        models: vec![provider_model("s/1", "other", "https://other/v1")],
        ..Default::default()
    });
    let effective = manager.effective_catalog(None, true).await;
    let user: Vec<&Model> = effective
        .models
        .iter()
        .filter(|m| m.provider == "tama")
        .collect();
    assert_eq!(user.len(), 1, "the discovered model is in the catalog");
    assert_eq!(user[0].id, "m/1");
    assert_eq!(user[0].api.as_deref(), Some("openai-completions"));
    assert_eq!(user[0].api_key, "k");
    assert_eq!(user[0].base_url, format!("http://{addr}/v1"));
    // The response lacks `max_model_len` → the default window.
    assert_eq!(user[0].context_window, DEFAULT_CONTEXT_WINDOW);
    // The seeded model coexists (no id clash).
    assert!(effective.models.iter().any(|m| m.provider == "other"));
    server.abort();
}

/// (ADR 0024) A provider with `api: "anthropic-messages"` yields an
/// effective-catalog model with `api: Some("anthropic-messages")` (the
/// provider's `api` decides the wire — the `SessionManager`'s default
/// factory dispatches on it; the pre-feature fixtures default to
/// `openai-completions` via the serde default, asserted in
/// `effective_catalog_discovers_a_user_provider`).
#[tokio::test]
async fn resolve_uses_the_provider_api() {
    let dir = temp_config_dir();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server =
        crate::test_support::raw_json_server(listener, 200, r#"{"data":[{"id":"m/1"}]}"#, None)
            .await;
    write_settings_provider_api(
        &dir,
        "anthropic",
        &format!("http://{addr}/v1"),
        "anthropic-messages",
    );
    let manager = SessionManager::new(dir.to_path_buf());
    let effective = manager.effective_catalog(None, true).await;
    let user: Vec<&Model> = effective
        .models
        .iter()
        .filter(|m| m.provider == "anthropic")
        .collect();
    assert_eq!(user.len(), 1, "the discovered model is in the catalog");
    // The provider's `api` decides the wire (NOT a hard-coded
    // `openai-completions`).
    assert_eq!(user[0].api.as_deref(), Some("anthropic-messages"));
    server.abort();
}

/// (ADR 0026) A provider with `api: "litellm"` yields an effective-catalog
/// model with `api: Some("litellm")` (the provider's `api` decides the wire
/// — and the wire for `litellm` is `openai-completions`, Task 3/ADR 0026).
#[tokio::test]
async fn resolve_uses_the_litellm_provider_api() {
    let dir = temp_config_dir();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    // The `litellm` discovery arm hits `{base}/model/info` — serve the
    // LiteLLM shape (the test_support `raw_json_server` is the 4-arg
    // `counter: Option<…>` variant; pass `None`).
    let server = crate::test_support::raw_json_server(
        listener,
        200,
        r#"{"data":[{"model_name":"lit/1","model_info":{"max_input_tokens":262144,"reasoning_effort_levels":["none","low"],"supports_reasoning":true}}]}"#,
        None,
    )
    .await;
    write_settings_provider_api(&dir, "llm", &format!("http://{addr}/v1"), "litellm");
    let manager = SessionManager::new(dir.to_path_buf());
    let effective = manager.effective_catalog(None, true).await;
    let user: Vec<&Model> = effective
        .models
        .iter()
        .filter(|m| m.provider == "llm")
        .collect();
    assert_eq!(user.len(), 1, "the discovered model is in the catalog");
    // The provider's `api` is stamped verbatim (NOT `openai-completions`).
    assert_eq!(user[0].api.as_deref(), Some("litellm"));
    // ... and the metadata mapped (the discovery arm actually ran):
    assert_eq!(user[0].context_window, 262144);
    assert_eq!(
        user[0].thinking_levels,
        vec!["none".to_string(), "low".to_string()]
    );
    server.abort();
}

// ── the per-model derived wire + the R5 propagation (T3b / #131) ────

/// The `litellm` resolve fixture: a raw server answering EVERY path with
/// one canned `LiteLLMModelInfoResponse` body (the ladder's rung 1 hits
/// `{base}/model/info`; a Claude-shaped payload also gets a 2xx on the
/// `/v1/messages` probe, which is what the Messages latch needs). Returns
/// the join handle so the caller aborts it, exactly like
/// `resolve_uses_the_litellm_provider_api` does.
async fn litellm_server(body: &str) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = crate::test_support::raw_json_server(listener, 200, body, None).await;
    (addr, server)
}

/// The models one provider contributed to the effective catalog.
fn user_rows(effective: &ModelCatalog, provider: &str) -> Vec<Model> {
    effective
        .models
        .iter()
        .filter(|m| m.provider == provider)
        .cloned()
        .collect()
}

/// (T3b #131, acceptance 2) A `litellm` payload whose deployment carries
/// `mode: "responses"` derives `api: "openai-responses"` — the first time
/// `api` is DERIVED rather than the provider clone.
#[tokio::test]
async fn resolve_derives_responses_wire_from_litellm_mode() {
    let dir = temp_config_dir();
    let (addr, server) = litellm_server(
        r#"{"data":[{"model_name":"r/1","model_info":{"max_input_tokens":8000,"mode":"responses"}}]}"#,
    )
    .await;
    write_settings_provider_api(&dir, "llm", &format!("http://{addr}/v1"), "litellm");
    let manager = SessionManager::new(dir.to_path_buf());
    let effective = manager.effective_catalog(None, true).await;
    let user = user_rows(&effective, "llm");
    assert_eq!(user.len(), 1);
    assert_eq!(
        user[0].api.as_deref(),
        Some("openai-responses"),
        "a `mode: \"responses\"` route derives the Responses wire"
    );
    server.abort();
}

/// (T3b #131) A `litellm` payload routing through a Claude adapter
/// (`anthropic/…` — T3a's `route_hint`) with the one-time `/v1/messages`
/// probe answering 2xx derives `api: "anthropic-messages"`.
#[tokio::test]
async fn resolve_derives_anthropic_messages_wire_for_claude_route() {
    let dir = temp_config_dir();
    // The canned body answers BOTH `GET /model/info` (rung 1) and the
    // `GET /v1/messages` liveness probe with a 200 — the probe's 2xx is
    // what T3a's latch reads as "Messages available".
    let (addr, server) = litellm_server(
        r#"{"data":[{"model_name":"anthropic/claude-sonnet","model_info":{"max_input_tokens":200000}}]}"#,
    )
    .await;
    write_settings_provider_api(&dir, "llm", &format!("http://{addr}/v1"), "litellm");
    let manager = SessionManager::new(dir.to_path_buf());
    let effective = manager.effective_catalog(None, true).await;
    let user = user_rows(&effective, "llm");
    assert_eq!(user.len(), 1);
    assert_eq!(
        user[0].api.as_deref(),
        Some("anthropic-messages"),
        "a Claude-adapter route with the messages probe passing derives the Messages wire"
    );
    server.abort();
}

/// (T3b #131, VF#2) A `litellm` payload with NO responses-mode and NO
/// messages evidence keeps the PROVIDER value `api: "litellm"` — the
/// byte-identical pre-T3b row. The completions fallback is wire-equivalent
/// to the `litellm` mode, and `litellm` additionally carries the discovery
/// shape (`api` selects `discover_models`' arm), so the derived
/// `openai-completions` deliberately does NOT overwrite it.
#[tokio::test]
async fn resolve_keeps_provider_api_when_no_wire_derived() {
    let dir = temp_config_dir();
    // A plain OpenAI-shaped LiteLLM route: no `mode`, no Claude adapter.
    let (addr, server) = litellm_server(
        r#"{"data":[{"model_name":"openai/gpt-4o","model_info":{"max_input_tokens":128000,"supports_function_calling":true}}]}"#,
    )
    .await;
    write_settings_provider_api(&dir, "llm", &format!("http://{addr}/v1"), "litellm");
    let manager = SessionManager::new(dir.to_path_buf());
    let effective = manager.effective_catalog(None, true).await;
    let user = user_rows(&effective, "llm");
    assert_eq!(user.len(), 1);
    assert_eq!(
        user[0].api.as_deref(),
        Some("litellm"),
        "the fallback arm is byte-identical to today's `Some(provider.api.clone())`"
    );
    server.abort();
}

/// (T3b #131, R5 — the task's biggest risk, pinned as a TEST) A
/// NON-`litellm` provider's `Model` row is BIT-IDENTICAL to the pre-feature
/// literals: the provider `api` clone (no derivation attempted, no
/// overwrite possible) + `supports_tools: true` / `0.0` / `0.0` from the
/// `unwrap_or` defaults (a non-LiteLLM `DiscoveredMeta` carries `None` in
/// all four additive fields).
#[tokio::test]
async fn resolve_non_litellm_provider_byte_identical() {
    let dir = temp_config_dir();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    // The Anthropic discovery shape (`id` ONLY — no metadata at all).
    let server =
        crate::test_support::raw_json_server(listener, 200, r#"{"data":[{"id":"m/1"}]}"#, None)
            .await;
    write_settings_provider_api(
        &dir,
        "anthropic",
        &format!("http://{addr}/v1"),
        "anthropic-messages",
    );
    let manager = SessionManager::new(dir.to_path_buf());
    let effective = manager.effective_catalog(None, true).await;
    let user = user_rows(&effective, "anthropic");
    assert_eq!(user.len(), 1);
    // The provider clone (a `litellm` payload could have derived anything;
    // this arm never derives).
    assert_eq!(user[0].api.as_deref(), Some("anthropic-messages"));
    // Today's hardcoded literals (session/mod.rs pre-T3b `:410-412`).
    assert!(
        user[0].supports_tools,
        "`unwrap_or(true)` reproduces `true`"
    );
    assert_eq!(
        user[0].cost_per_mtok_in, 0.0,
        "`unwrap_or(0.0)` reproduces 0.0"
    );
    assert_eq!(
        user[0].cost_per_mtok_out, 0.0,
        "`unwrap_or(0.0)` reproduces 0.0"
    );
    server.abort();
}

/// (T3b #131, R5) The REDUCED discovery values reach the `Model` row: a
/// route whose deployment does NOT advertise `supports_function_calling`
/// reduces to `supports_tools: false` (the ALL-deployments gate), and the
/// per-token costs × 1e6 become the row's costs — NOT the defaults (a
/// wrongly-`true` `supports_tools` would offer an unselectable wire).
#[tokio::test]
async fn resolve_propagates_reduced_supports_tools_and_costs_for_litellm() {
    let dir = temp_config_dir();
    let (addr, server) = litellm_server(
        r#"{"data":[{"model_name":"r/1","model_info":{"max_input_tokens":8000,"input_cost_per_token":0.0000025,"output_cost_per_token":0.000006}}]}"#,
    )
    .await;
    write_settings_provider_api(&dir, "llm", &format!("http://{addr}/v1"), "litellm");
    let manager = SessionManager::new(dir.to_path_buf());
    let effective = manager.effective_catalog(None, true).await;
    let user = user_rows(&effective, "llm");
    assert_eq!(user.len(), 1);
    assert!(
        !user[0].supports_tools,
        "a deployment that never advertised `supports_function_calling` reduces to `false`"
    );
    assert_eq!(
        user[0].cost_per_mtok_in, 2.5,
        "per-token × 1e6 (the reduction's max)"
    );
    assert_eq!(user[0].cost_per_mtok_out, 6.0);
    server.abort();
}

/// (ADR 0014) A provider whose discovery FAILS (unreachable endpoint)
/// still SHADOWS the seeded models for its id (a transient failure
/// must not resurrect stale seeded models under the same id).
#[tokio::test]
async fn effective_catalog_a_failed_discovery_still_shadows_the_seeded_provider() {
    let dir = temp_config_dir();
    write_settings_provider(&dir, "tama", "http://127.0.0.1:1/v1"); // unreachable
    let mut manager = SessionManager::new(dir.to_path_buf());
    manager.set_catalog(ModelCatalog {
        models: vec![
            provider_model("stale/1", "tama", "https://stale/v1"),
            provider_model("q/1", "q", "https://q/v1"),
        ],
        default_model: Some("tama/stale/1".to_string()),
        ..Default::default()
    });
    let effective = manager.effective_catalog(None, true).await;
    assert!(
        !effective.models.iter().any(|m| m.provider == "tama"),
        "a failed discovery must NOT resurrect the stale seeded models"
    );
    // A non-shadowed provider's seeded models survive.
    assert!(effective.models.iter().any(|m| m.provider == "q"));
    // The seeded default belonged to the shadowed provider → `None`.
    assert_eq!(effective.default_model, None);
}

/// (ADR 0014) The discovery is CACHED per provider (a second
/// `effective_catalog` is not re-fetched), and a `force_refresh` for
/// the provider BYPASSES the cache (a fresh fetch overwrites the
/// entry — even a re-pointed `base_url` is honored, the `settings.json`
/// read is fresh).
#[tokio::test]
async fn effective_catalog_caches_and_force_refresh_bypasses_the_cache() {
    let dir = temp_config_dir();
    let counter = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = crate::test_support::raw_json_server(
        listener,
        200,
        r#"{"data":[{"id":"v1"}]}"#,
        Some(counter.clone()),
    )
    .await;
    write_settings_provider(&dir, "tama", &format!("http://{addr}/v1"));
    let mut manager = SessionManager::new(dir.to_path_buf());
    manager.set_catalog(ModelCatalog::default());
    let first = manager.effective_catalog(None, true).await;
    assert!(first.models.iter().any(|m| m.id == "v1"));
    // Second call: the cache serves it (the server is NOT hit again).
    let second = manager.effective_catalog(None, true).await;
    assert_eq!(
        counter.load(std::sync::atomic::Ordering::Relaxed),
        1,
        "the second call must be cache-served"
    );
    assert!(second.models.iter().any(|m| m.id == "v1"));
    // A `force_refresh` for the provider bypasses the cache (a fresh
    // fetch overwrites the entry — a NEW response body is asserted via
    // the counter-driven flow: re-point the provider at a second
    // listener serving `v2`).
    let listener2 = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr2 = listener2.local_addr().unwrap();
    let server2 = crate::test_support::raw_json_server(
        listener2,
        200,
        r#"{"data":[{"id":"v2"}]}"#,
        Some(counter.clone()),
    )
    .await;
    write_settings_provider(&dir, "tama", &format!("http://{addr2}/v1"));
    let refreshed = manager.effective_catalog(Some("tama"), true).await;
    assert_eq!(
        counter.load(std::sync::atomic::Ordering::Relaxed),
        2,
        "the force refresh must re-fetch"
    );
    assert!(refreshed.models.iter().any(|m| m.id == "v2"));
    assert!(!refreshed.models.iter().any(|m| m.id == "v1"));
    server.abort();
    server2.abort();
}

/// (#85) A FAILED discovery must not latch for the process's life.
///
/// The cache marks a provider `attempted` before the fetch, and the failure
/// arm used to leave it that way with `models` cleared — so a provider whose
/// endpoint was unreachable ONCE (the app launched before the network was up,
/// a gateway mid-restart) contributed 0 models for the rest of the run. The
/// provider row showed `unreachable`, the model picker was short its models,
/// and nothing short of a restart or that provider's own refresh recovered
/// it. A SUCCESS still caches (the whole point of the cache); only the
/// failure is retried.
///
/// This is the same defect as #85's stale window one layer down: the cache
/// holding a wrong answer with no path to correction.
#[tokio::test]
async fn a_failed_discovery_does_not_latch_the_negative_result() {
    let dir = temp_config_dir();
    // Port 1 refuses instantly — a deterministic "unreachable" (no timeout
    // to wait out), the same fixture the shadow test uses.
    write_settings_provider(&dir, "tama", "http://127.0.0.1:1/v1");
    let mut manager = SessionManager::new(dir.to_path_buf());
    manager.set_catalog(ModelCatalog::default());
    let failed = manager.effective_catalog(None, true).await;
    assert!(
        !failed.models.iter().any(|m| m.provider == "tama"),
        "the first attempt genuinely failed"
    );
    // The endpoint comes good (the provider is re-pointed at a live server —
    // the `settings.json` read is fresh, exactly as the force-refresh test
    // relies on).
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = crate::test_support::raw_json_server(
        listener,
        200,
        r#"{"data":[{"id":"recovered"}]}"#,
        None,
    )
    .await;
    write_settings_provider(&dir, "tama", &format!("http://{addr}/v1"));
    // NO `force_refresh`: an ordinary read must retry a provider whose last
    // attempt FAILED.
    let retried = manager.effective_catalog(None, true).await;
    assert!(
        retried.models.iter().any(|m| m.id == "recovered"),
        "a plain read must retry a previously-FAILED provider — a transient \
         failure must not blacklist it for the process's life"
    );
    server.abort();
}

/// ADR 0044: `/compact` on a session that is NOT live (a stored session)
/// is a NO-OP, not an error — resuming a session in order to compact it is
/// a larger flow than the command is worth. `Ok(false)` = "nothing ran".
#[tokio::test]
async fn compact_session_on_a_non_live_session_is_a_no_op() {
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, _wm, _db) = build_worker_manager(&dir, native_test_catalog(), &sink);
    assert!(
        !manager
            .compact_session("arch_not_live", None)
            .await
            .expect("a stored session is not an error"),
        "a non-live session compacts nothing (false)"
    );
}

/// `/compact` on a LIVE session sends the `compact` frame (`Ok(true)` —
/// the return is "the frame was sent", not "the transcript shrank": the
/// Worker emits the frames) and touches NOTHING else: above all it does
/// NOT set `cancel_requested` (`send_prompt` clears it and the router
/// reads it only while a turn slot is occupied, so an idle compaction that
/// set it would map the NEXT settle to `Cancelled`).
#[tokio::test]
async fn compact_session_sends_the_frame_and_never_marks_a_cancel() {
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, _wm, _db) = build_worker_manager(&dir, native_test_catalog(), &sink);
    let info = manager
        .start_session(dir.to_path_buf(), &sink)
        .await
        .expect("the native session started");
    assert!(
        manager
            .compact_session(&info.session_id, Some("keep the tests".to_string()))
            .await
            .expect("the live send succeeds"),
        "the frame was sent to the live session"
    );
    let cancel_requested = manager
        .with_session(&info.session_id, |s| {
            s.live.as_ref().map(|live| {
                *live
                    .cancel_requested
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
            })
        })
        .flatten();
    assert_eq!(
        cancel_requested,
        Some(false),
        "an idle compaction does not touch the session's cancel flag"
    );
}

#[test]
fn session_manager_builder_cyclic_weak_reference_drops_cleanly() {
    let dir = temp_config_dir();
    let db = open_db(&dir);
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let persister = Arc::new(TranscriptPersister::new(db.clone()));

    let (manager, wm) = SessionManagerBuilder::new(dir.to_path_buf(), db, sink, persister)
        .with_worker_factory(Arc::new(FixtureFactory))
        .build();

    // WorkerManager's hooks hold a Weak<SessionManager>.
    // Dropping the manager should drop the underlying SessionManager.
    drop(manager);

    // Weak upgrade must fail cleanly
    assert!(wm.hooks().sink_for("any").is_none());
}

#[test]
fn session_manager_builder_preserves_supplied_persister() {
    let dir = temp_config_dir();
    let db = open_db(&dir);
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let persister = Arc::new(TranscriptPersister::new(db.clone()));

    let (manager, _wm) = SessionManagerBuilder::new(dir.to_path_buf(), db, sink, persister.clone())
        .with_worker_factory(Arc::new(FixtureFactory))
        .build();

    assert!(
        Arc::ptr_eq(
            &persister,
            &manager.persister().expect("persister should be set")
        ),
        "SessionManager must use the exact persister instance provided to the builder"
    );
}

// ── Task 4: the `allow-directory` relay persistence ───────────────────
//
// The relay's persistence half of ADR 0025: an "Always allow this
// directory" answer appends EXACTLY ONE `allow` rule to `settings.json`'s
// `rules` key — which holds ONLY user rules (`default_rules()` is
// runtime-only and never serialized), so the file-side half of the
// ordering contract is "appended AFTER the pre-existing user rules". The
// RUNTIME half (defaults FIRST, then the user rules, so an appended allow
// wins an exact tie against a default `deny`) is the harness concat site's
// half, and the tie itself is pinned in `agent/policy.rs`'s
// `an_exact_tie_goes_to_the_last_rule_so_an_appended_allow_beats_a_default_deny`.
// Concatenate the other way round and every rule written here silently
// no-ops at the gate.

/// The FILE side of the ordering contract: exactly ONE rule appended, at
/// the END of the pre-existing user rules, nothing else in the document
/// touched. Seeded with a real user rule (the file has no defaults in it —
/// a `rules[..default_rules().len()] == default_rules()` assertion would
/// be false on every machine).
#[tokio::test]
async fn an_allow_directory_answer_appends_exactly_one_rule_after_the_existing_user_rules() {
    use crate::agent::policy::{AccessRule, RuleDecision, RuleDirection};
    use crate::config::load_settings;

    let dir = temp_config_dir();
    write_settings_json(
        &dir,
        serde_json::json!({
            "filePolicy": {
                "reads": "allow", "writes": "allow", "shell": "allow",
                "rules": [{ "path": "/Users/u/older", "direction": "write", "decision": "deny" }]
            }
        }),
    );
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, info) = start_native_session(&dir, &sink).await;

    manager.persist_allow_directory_rule(Some("/Users/u/skills"));

    let rules = load_settings(dir.path()).file_policy.rules;
    assert_eq!(
        rules.len(),
        2,
        "exactly ONE rule appended to the pre-existing user rules"
    );
    assert_eq!(
        rules[0],
        AccessRule {
            path: "/Users/u/older".to_string(),
            direction: RuleDirection::Write,
            decision: RuleDecision::Deny,
        },
        "the pre-existing user rule is untouched and still FIRST"
    );
    assert_eq!(
        rules[1],
        AccessRule {
            path: "/Users/u/skills".to_string(),
            direction: RuleDirection::ReadWrite,
            decision: RuleDecision::Allow,
        },
        "the new allow lands at the END of the user rules — the file-side half of the CONCATENATION CONTRACT"
    );
    let _ = manager.close_session(&info.session_id).await;
}

/// A `None` value, the gate's `""` placeholder, and an all-whitespace path
/// all persist NOTHING — a rule matching nothing would pollute the file,
/// the Settings list, and the round-trip. T03 replaces the placeholder;
/// this pin keeps the seam honest until then.
#[tokio::test]
async fn a_blank_or_absent_value_persists_nothing() {
    use crate::config::load_settings;

    let dir = temp_config_dir();
    write_settings_json(&dir, serde_json::json!({}));
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, info) = start_native_session(&dir, &sink).await;

    manager.persist_allow_directory_rule(None);
    manager.persist_allow_directory_rule(Some(""));
    manager.persist_allow_directory_rule(Some("   "));

    let settings = load_settings(dir.path());
    assert!(
        settings.file_policy.rules.is_empty(),
        "a blank path persists nothing, got {:?}",
        settings.file_policy.rules
    );
    let _ = manager.close_session(&info.session_id).await;
}

/// A repeat click on the same directory is idempotent: dedupe by
/// path + direction + decision, so the second click writes nothing rather
/// than a duplicate row that re-orders the file.
#[tokio::test]
async fn a_second_click_on_the_same_directory_is_idempotent() {
    use crate::agent::policy::{RuleDecision, RuleDirection};
    use crate::config::load_settings;

    let dir = temp_config_dir();
    write_settings_json(&dir, serde_json::json!({}));
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, info) = start_native_session(&dir, &sink).await;

    manager.persist_allow_directory_rule(Some("/Users/u/skills"));
    manager.persist_allow_directory_rule(Some("/Users/u/skills"));

    let settings = load_settings(dir.path());
    assert_eq!(
        settings.file_policy.rules.len(),
        1,
        "one rule total, not two"
    );
    assert_eq!(
        settings
            .file_policy
            .rules
            .iter()
            .filter(|r| r.direction == RuleDirection::ReadWrite
                && r.decision == RuleDecision::Allow)
            .count(),
        1,
        "a repeat click must NOT append a duplicate rule"
    );
    let _ = manager.close_session(&info.session_id).await;
}

/// The dedupe is EXACT identity, never a path key: a hand-written `Deny`
/// for the same path is a DIFFERENT rule, so the allow coexists with it
/// (and the last-wins tie-break in `rule_for` is what decides).
#[tokio::test]
async fn a_differing_rule_for_the_same_path_still_appends() {
    use crate::agent::policy::{RuleDecision, RuleDirection};
    use crate::config::load_settings;

    let dir = temp_config_dir();
    write_settings_json(
        &dir,
        serde_json::json!({
            "filePolicy": {
                "reads": "allow", "writes": "allow", "shell": "allow",
                "rules": [{ "path": "/Users/u/skills", "direction": "write", "decision": "deny" }]
            }
        }),
    );
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, info) = start_native_session(&dir, &sink).await;

    manager.persist_allow_directory_rule(Some("/Users/u/skills"));

    let rules = load_settings(dir.path()).file_policy.rules;
    assert_eq!(rules.len(), 2, "a differing rule is NOT deduped away");
    assert!(rules
        .iter()
        .any(|r| r.direction == RuleDirection::Write && r.decision == RuleDecision::Deny));
    assert!(rules
        .iter()
        .any(|r| r.direction == RuleDirection::ReadWrite && r.decision == RuleDecision::Allow));
    let _ = manager.close_session(&info.session_id).await;
}

/// The persist arm lives INSIDE `respond_permission`'s send-success arm,
/// so a `handle_for` miss (`Ok(false)`) reaches neither the trust-space
/// write nor the rule append.
#[tokio::test]
async fn a_missing_worker_routes_the_answer_to_nowhere_and_writes_no_rule() {
    use crate::agent::permission::PermissionOutcome;
    use crate::config::load_settings;

    let dir = temp_config_dir();
    write_settings_json(&dir, serde_json::json!({}));
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, _wm, _db) = build_worker_manager(&dir, native_test_catalog(), &sink);
    // NO session is started — `handle_for` misses → `Ok(false)` and the
    // `Ok(())` arm (where the persistence lives) is never reached.
    let hit = manager
        .respond_permission(
            "no-such-session",
            "req-1",
            PermissionOutcome::Selected {
                option_id: PERMISSION_OPTION_ALLOW_DIRECTORY.to_string(),
                value: Some("/Users/u/skills".to_string()),
            },
        )
        .await
        .expect("the miss is Ok(false), not Err");
    assert!(!hit, "a missing worker is a no-op");
    assert!(
        load_settings(dir.path()).file_policy.rules.is_empty(),
        "no session → no write"
    );
}

/// The `trust-space` persistence arm is UNCHANGED by the `value`
/// destructure: an answer still flips the `spaces` row (seeded first —
/// `set_space_trusted` is an UPDATE) and writes NO rule.
#[tokio::test]
async fn the_trust_space_persistence_arm_is_unchanged() {
    use crate::config::load_settings;

    let dir = temp_config_dir();
    write_settings_json(&dir, serde_json::json!({}));
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, _wm, db) = build_worker_manager(&dir, native_test_catalog(), &sink);
    let info = manager
        .start_session(dir.to_path_buf(), &sink)
        .await
        .expect("the native session started");

    let cwd = info.cwd.clone();
    // `set_space_trusted` is an UPDATE — a missing row is a no-op, so the
    // row must exist (INSERT) before the arm can flip it.
    db.upsert_space(&cwd.display().to_string(), false)
        .expect("the space row is seeded");

    manager
        .respond_permission(
            &info.session_id,
            "req-1",
            crate::agent::permission::PermissionOutcome::Selected {
                option_id: PERMISSION_OPTION_TRUST_SPACE.to_string(),
                value: None,
            },
        )
        .await
        .expect("the answer relays");

    assert!(
        db.space_trusted(&cwd).expect("space_trusted should work"),
        "the trust-space arm still flips the `spaces` row"
    );
    assert!(
        load_settings(dir.path()).file_policy.rules.is_empty(),
        "trust-space writes NO rule"
    );
    let _ = manager.close_session(&info.session_id).await;
}

/// The child path (a subagent rides this same relay through `handle_for`'s
/// `drives` fallback and has NO `live` entry, so `cwd` is `None` for it)
/// is covered by CONSTRUCTION, not by a fixture: the persistence method
/// reads `value` and `config_dir` ONLY — no `self.live`, no `self.driver`,
/// no `db` — which its doc states as a checkable guarantee. Driving a real
/// child-shaped `respond_permission` is not possible with these fixtures
/// (`start_native_session` always carries a main-session `live` entry with
/// a `cwd`, and a manager with no live entry misses `handle_for` — which is
/// the `Ok(false)` pin above). This test pins the observable half of that
/// construction claim: the write happens on a manager with NO live session
/// at all — nothing but the `value` and the config dir is involved.
#[tokio::test]
async fn the_persist_write_needs_no_live_session_state() {
    use crate::agent::policy::{RuleDecision, RuleDirection};
    use crate::config::load_settings;

    let dir = temp_config_dir();
    write_settings_json(&dir, serde_json::json!({}));
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    // NO session started: no `live` entry, no `cwd`, nothing attached
    // beyond the `db` the builder wires. The method still persists —
    // because its ONLY inputs are the `value` and `config_dir`.
    let (manager, _wm, _db) = build_worker_manager(&dir, native_test_catalog(), &sink);

    manager.persist_allow_directory_rule(Some("/Users/u/child-skills"));

    let rules = load_settings(dir.path()).file_policy.rules;
    assert_eq!(rules.len(), 1, "the value-only write needs no session");
    assert_eq!(
        rules[0],
        crate::agent::policy::AccessRule {
            path: "/Users/u/child-skills".to_string(),
            direction: RuleDirection::ReadWrite,
            decision: RuleDecision::Allow,
        },
        "the persisted rule is the `value` verbatim, ReadWrite/Allow"
    );
}

// ── (#154) `set_config_option` with NO live Worker ─────────────────────

/// (#154) A `set_config_option` model change with NO live Worker and NO
/// `config_state` entry (a stored / cleanly-closed session) persists to the
/// row and is OBSERVED on the next resume (a write nothing reads would be a
/// pin that passes on the broken thing).
#[tokio::test]
async fn a_model_change_persists_without_a_live_worker_and_resume_observes_it() {
    let catalog = ModelCatalog {
        models: vec![
            level_test_model("tama", "a", &["off", "high"]),
            level_test_model("tama", "b", &["off", "low", "medium", "xhigh"]),
        ],
        default_model: Some("tama/a".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    write_settings_json(&dir, serde_json::json!({}));
    // NO start_session: the manager works from a plain stored row (the
    // `config_state` map is empty — the state a clean close / a stored
    // session has).
    let (manager, _wm, db) = build_worker_manager(&dir, catalog, &sink);
    db.record_session(&SessionInfo {
        session_id: "nat-nolive-1".to_string(),
        cwd: dir.to_path_buf(),
        capabilities: json!({
            "native": true,
            "model": "tama/a",
            "thinkingLevel": "high",
            "loadSession": true,
        }),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    })
    .expect("record_session should succeed");
    assert!(
        !manager
            .with_session("nat-nolive-1", |s| s.config_state.is_some())
            .unwrap_or_default(),
        "precondition: no config_state entry (that is the stopped-session trap)"
    );

    // The seam: NO live worker exists (nothing was started), so the change
    // must PERSIST, not error, and return the re-synthesized options.
    let options = manager
        .set_config_option("nat-nolive-1", "model", "tama/b", &sink)
        .await
        .expect("a stored session accepts a model change (persist, not error)");
    let model_opt = options
        .iter()
        .find(|o| o["id"] == "model")
        .expect("the model selector is returned");
    assert_eq!(
        model_opt["currentValue"], "tama/b",
        "the returned options reflect the new value (the frontend reads currentValue)"
    );
    let row = db
        .session("nat-nolive-1")
        .expect("db.session should succeed")
        .expect("the row exists");
    let caps: serde_json::Value =
        serde_json::from_str(&row.capabilities_json).expect("valid capabilities_json");
    assert_eq!(
        caps["model"], "tama/b",
        "the persisted row carries the new composed key"
    );

    // OBSERVED on the next resume: the boot model comes from the row.
    let resumed = manager
        .resume_session("nat-nolive-1", dir.to_path_buf(), &sink)
        .await
        .expect("the stored session resumes on the persisted model");
    assert_eq!(
        resumed.capabilities["model"], "tama/b",
        "the persisted change is observed on the subsequent resume"
    );
    let _ = manager.close_session(&resumed.session_id).await;
}

/// (#154) A `set_config_option` "thought_level" change with NO live Worker
/// persists to the row (the STORED rung) AND to the remembered
/// `default_thinking_levels` map (the REMEMBERED rung, ADR 0015), and the
/// change is OBSERVED on resume. The settings file is seeded EMPTY so the
/// remembered map cannot smuggle the value in: the STORED rung alone must
/// win — with an empty map it is the only rung that can (remembered >
/// stored > settings default; `establish_worker_session`).
#[tokio::test]
async fn a_thought_level_change_persists_without_a_live_worker_and_resume_observes_it() {
    let catalog = ModelCatalog {
        models: vec![level_test_model("tama", "a", &["off", "high", "xhigh"])],
        default_model: Some("tama/a".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    // EMPTY remembered map (the precondition).
    write_settings_json(&dir, serde_json::json!({}));
    let (manager, _wm, db) = build_worker_manager(&dir, catalog, &sink);
    db.record_session(&SessionInfo {
        session_id: "nat-nolive-lvl-1".to_string(),
        cwd: dir.to_path_buf(),
        capabilities: json!({
            "native": true,
            "model": "tama/a",
            "thinkingLevel": "high",
            "loadSession": true,
        }),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    })
    .expect("record_session should succeed");

    let options = manager
        .set_config_option("nat-nolive-lvl-1", "thought_level", "xhigh", &sink)
        .await
        .expect("a stored session accepts a thinking-level change");
    let level = options
        .iter()
        .find(|o| o["id"] == "thought_level")
        .expect("the thinking-level selector is present");
    assert_eq!(
        level["currentValue"], "xhigh",
        "the returned option carries the new value"
    );

    // STORED rung: the row's capability envelope carries the new level.
    let row = db
        .session("nat-nolive-lvl-1")
        .expect("db.session should succeed")
        .expect("the row exists");
    let caps: serde_json::Value =
        serde_json::from_str(&row.capabilities_json).expect("valid capabilities_json");
    assert_eq!(
        caps["thinkingLevel"], "xhigh",
        "the STORED rung carries the new level"
    );

    // REMEMBERED rung: the settings file also received the new value (keyed
    // by the session's model). Both rungs carry the new value — which is the
    // ONLY way "whichever rung wins, it is the new value" is true.
    let settings = load_settings(&dir);
    assert_eq!(
        settings.default_thinking_levels.get("tama/a"),
        Some(&"xhigh".to_string()),
        "the REMEMBERED rung also carries the new level (the existing remembered write kept)"
    );

    // OBSERVED on resume: with the empty remembered map the STORED rung is
    // the decisive one (the precondition the seeding of `{}` enforces).
    let resumed = manager
        .resume_session("nat-nolive-lvl-1", dir.to_path_buf(), &sink)
        .await
        .expect("the stored session resumes on the persisted level");
    assert_eq!(
        resumed.capabilities["thinkingLevel"], "xhigh",
        "the persisted level is observed on the subsequent resume"
    );
    let _ = manager.close_session(&resumed.session_id).await;
}

/// (#154) The gap the `"thought_level"` arm had on the LIVE path too: it
/// wrote ONLY `settings.json`'s remembered level, so a level changed on a
/// running session never reached the session's own row. A live level change
/// must land in `capabilities_json` AND be observed on the next resume (the
/// optional live-path pin the plan allows — it is the arm's row write under
/// a handle, where the transport still runs).
#[tokio::test]
async fn a_native_thought_level_change_persists_the_level_to_the_row() {
    let catalog = ModelCatalog {
        models: vec![level_test_model(
            "tama",
            "a",
            &["off", "low", "medium", "high"],
        )],
        default_model: Some("tama/a".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    write_settings_json(&dir, serde_json::json!({}));
    let (manager, _wm, db) = build_worker_manager(&dir, catalog, &sink);
    let info = manager
        .start_session(dir.to_path_buf(), &sink)
        .await
        .expect("the native session started");

    manager
        .set_config_option(&info.session_id, "thought_level", "medium", &sink)
        .await
        .expect("the live level change applies");

    let row = db
        .session(&info.session_id)
        .expect("db.session should succeed")
        .expect("the row exists");
    let caps: serde_json::Value =
        serde_json::from_str(&row.capabilities_json).expect("valid capabilities_json");
    assert_eq!(
        caps["thinkingLevel"], "medium",
        "a LIVE level change reaches the row (the arm wrote only settings.json before)"
    );

    let _ = manager.close_session(&info.session_id).await;
    let resumed = manager
        .resume_session(&info.session_id, dir.to_path_buf(), &sink)
        .await
        .expect("the session resumes");
    assert_eq!(
        resumed.capabilities["thinkingLevel"], "medium",
        "the live level change survives the restart"
    );
    let _ = manager.close_session(&resumed.session_id).await;
}

/// (rev/2 finding 1) (#154) A session id with NO row and NO live Worker is
/// UNKNOWN: `set_config_option` must return `UnknownSession`, create NO row,
/// and create NO `config_state` map entry. Without the row guard this would
/// have returned `Ok(populated_options)`, emitted `config_option_update` and
/// leaked a phantom `SessionState` entry (`update_session_capabilities` is a
/// silent no-op on a missing row; `with_session_entry` CREATES map rows).
#[tokio::test]
async fn a_ghost_session_id_still_returns_unknown_session_and_creates_nothing() {
    let catalog = ModelCatalog {
        models: vec![level_test_model("tama", "a", &["off", "high"])],
        default_model: Some("tama/a".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    write_settings_json(&dir, serde_json::json!({}));
    let (manager, _wm, db) = build_worker_manager(&dir, catalog, &sink);

    let err = manager
        .set_config_option("ghost-id", "model", "tama/a", &sink)
        .await
        .expect_err("an id with no row is unknown, on every path");
    assert!(
        matches!(err, SessionError::UnknownSession { ref id } if id == "ghost-id"),
        "the unknown session guard fires, got {err:?}"
    );
    assert!(
        db.session("ghost-id").expect("db read").is_none(),
        "no row was created (the persist is a silent no-op, never a create)"
    );
    assert!(
        manager
            .with_session("ghost-id", |s| s.config_state.is_none())
            .is_none(),
        "no phantom `SessionState` map entry was created"
    );
}

/// (#154) The fallback config arm (an unknown config id) has NO persistence
/// semantics: it must keep returning `Command("unknown config option: …")`
/// even for a stored session (whose row the new guard passes), and leave the
/// row (and the map) untouched.
#[tokio::test]
async fn a_stored_session_still_rejects_an_unknown_config_option() {
    let catalog = ModelCatalog {
        models: vec![level_test_model("tama", "a", &["off", "high"])],
        default_model: Some("tama/a".to_string()),
        compaction: crate::agent::harness::catalog::CompactionConfig::default(),
    };
    let dir = temp_config_dir();
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    write_settings_json(&dir, serde_json::json!({}));
    // The settings file as the fixture left it — the byte-for-byte pin that
    // the rejected change wrote NOTHING (the plan's `["defaultThinkingLevels"]`
    // indexing would compare `Null` against `{}` for a key the seed omits).
    let settings_before = std::fs::read_to_string(dir.join("settings.json")).unwrap();
    let (manager, _wm, db) = build_worker_manager(&dir, catalog, &sink);
    db.record_session(&SessionInfo {
        session_id: "nat-reject-1".to_string(),
        cwd: dir.to_path_buf(),
        capabilities: json!({
            "native": true,
            "model": "tama/a",
            "thinkingLevel": "high",
            "loadSession": true,
        }),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    })
    .expect("record_session should succeed");

    let err = manager
        .set_config_option("nat-reject-1", "bogus", "x", &sink)
        .await
        .expect_err("an unknown config id is rejected");
    assert!(
        matches!(err, SessionError::Command { ref error } if error == "unknown config option: bogus"),
        "the fallback arm keeps failing, got {err:?}"
    );
    let row = db
        .session("nat-reject-1")
        .expect("db.session should succeed")
        .expect("the row exists");
    let caps: serde_json::Value =
        serde_json::from_str(&row.capabilities_json).expect("valid capabilities_json");
    assert_eq!(caps["model"], "tama/a", "the row is unchanged");
    assert_eq!(caps["thinkingLevel"], "high", "the row is unchanged");
    assert!(
        !manager
            .with_session("nat-reject-1", |s| s.config_state.is_some())
            .unwrap_or_default(),
        "no config_state was seeded for a rejected change"
    );
    let settings_after = std::fs::read_to_string(dir.join("settings.json")).unwrap();
    assert_eq!(
        settings_after, settings_before,
        "settings.json is untouched by a rejected change"
    );
}

/// The DRIFT PIN for the `option_id` wire vocabulary (consumer side).
/// The two ids are PRODUCED in `fulcrum-core` (`permission.rs`) and forwarded
/// verbatim by the frontend (`PermissionPrompt.tsx` sends `option.optionId`
/// back untouched; TS widens to `string`), so a desktop-side pin can only
/// assert this CONSUMER side — the two compares and the two fixtures share
/// these constants. A cross-package producer pin is refused by repo policy
/// (single-language pins only — see `src/lib/tauri/events.ts`, which refuses
/// grep-parity as unsound). The realistic trigger this catches is a desktop
/// typo in the compare: `respond_permission` returns `Ok(true)` and the modal
/// closes either way, so a misspelt id is SILENT failure — the rule/trust
/// write quietly stops.
#[test]
fn permission_option_id_spellings_are_frozen() {
    let frozen: &[(&str, &str)] = &[
        ("trust-space", PERMISSION_OPTION_TRUST_SPACE),
        ("allow-directory", PERMISSION_OPTION_ALLOW_DIRECTORY),
    ];
    let spelled: Vec<&str> = frozen.iter().map(|(_, c)| *c).collect();
    assert_eq!(
        spelled,
        vec!["trust-space", "allow-directory"],
        "the option_id spellings are frozen (consumer side — producers live in fulcrum-core)"
    );
    for (expected, constant) in frozen {
        assert_eq!(
            *constant, *expected,
            "frozen spelling for option_id {constant}"
        );
    }
}

/// The DRIFT PIN for the `session-closed` wire vocabulary. The reason value
/// crosses the boundary as `reason.as_str()` inside `json!`
/// (`router.rs`'s `session-closed` emission — never serde-serialized), and
/// the frontend mirror is the hand-written union
/// `export type CloseReasonStr = "user" | "agent-exited" | "error";`
/// (`src/lib/tauri/types.ts`, barrel-pinned). A new variant, or a
/// spelling drift in `ClosedReason::as_str`, fails HERE before CI sees it.
#[test]
fn closed_reason_spellings_are_frozen() {
    let frozen: &[(&str, ClosedReason)] = &[
        ("user", ClosedReason::User),
        ("agent-exited", ClosedReason::AgentExited),
        ("error", ClosedReason::Error),
    ];
    let spelled: Vec<&'static str> = frozen.iter().map(|(_, r)| r.as_str()).collect();
    assert_eq!(
        spelled,
        vec!["user", "agent-exited", "error"],
        "the ClosedReason::as_str vocabulary is frozen (see the TS union above)"
    );
    for (expected, reason) in frozen {
        assert_eq!(reason.as_str(), *expected, "frozen spelling for {reason:?}");
    }
}
