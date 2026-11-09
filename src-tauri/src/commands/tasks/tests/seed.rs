//! A4 — `start_task_session`: the board's New-Task flow (spec §3).
//!
//! The harness here REPLICATES `agent/session/tests/mod.rs`'s worker-manager
//! builder rather than importing it, deliberately: these tests live at
//! `crate::commands::tasks::tests::seed` and `mod session` is private
//! (`agent/mod.rs:24`), so none of that module's test helpers are reachable —
//! the same wall `commands/attention.rs:31-33` documents. Everything used below
//! is public API (`SessionManager`'s setters, `WorkerManager::new`, the
//! `on_worker_event` / `on_worker_crash` public aliases).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

use crate::agent::harness::{Model, ModelCatalog};
use crate::agent::worker::client::{WorkerError, WorkerHandle};
use crate::agent::worker::manager::WorkerFactory;
use crate::agent::worker::manager::WorkerManager;
use crate::agent::{EventSink, SessionManager};
use crate::storage::Db;
use crate::test_support::ScratchDir;
use crate::types::SessionInfo;

use crate::commands::tasks::{start_task_session_inner, write_task_session_link};

/// The native test catalog (a single `fake/m1` OpenAI-compatible model) — a
/// copy of `session/tests/mod.rs::native_test_catalog`, because that module is
/// unreachable from here. `http://fake` deliberately does not resolve: the
/// best-effort metadata refresh degrades to the static entry (the same thing the
/// session tests rely on), so no test here can reach the network.
fn task_test_catalog() -> ModelCatalog {
    ModelCatalog {
        models: vec![Model {
            id: "m1".to_string(),
            provider: "fake".to_string(),
            base_url: "http://fake".to_string(),
            api_key: "k".to_string(),
            context_window: 128_000,
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

/// The `fake_worker` fixture factory (the `WorkerFactory` seam — the workspace
/// root's `cargo test` builds the bin target, which is how the existing lib unit
/// tree already reaches it; the fixture answers the `ready` handshake and the
/// `start` frame).
struct TaskFixtureFactory;

impl WorkerFactory for TaskFixtureFactory {
    fn spawn(&self) -> Result<WorkerHandle, WorkerError> {
        WorkerHandle::spawn(&fixture_path())
    }
}

/// The `fake_worker` fixture path (the WORKSPACE ROOT's `target/debug` — the
/// same resolver `session/tests/mod.rs::fixture_path` uses).
fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("the src-tauri package has a parent (the repo root)")
        .join("target/debug/fake_worker")
}

/// A no-op `EventSink` (one emit arm, discarded). The session tests' `TestSink`
/// is unreachable from here; nothing in this tree asserts on emitted frames —
/// the load-bearing observations are the `task_sessions` row, the Worker
/// registry, and the registry's stored `StartEnv`.
struct DiscardingSink;

impl EventSink for DiscardingSink {
    fn emit(&self, _event: &str, _payload: Value) {}
}

/// Build the Worker-mediated `SessionManager` (the ADR 0025 late-wire, through
/// public API only) + the `WorkerManager` + the `Db`, on a scratch dir.
///
/// Returns the SAME `Arc<dyn EventSink>` the manager holds, because that is what
/// production hands the command: `lib.rs::init_dir_deps` manages `sink.clone()`
/// and passes `sink.clone()` to the builder, so `start_task_session`'s `sink`
/// state and the manager's router sink are one object.
fn build_manager(
    dir: &Path,
) -> (
    Arc<SessionManager>,
    Arc<WorkerManager>,
    Arc<Db>,
    Arc<dyn EventSink>,
) {
    let db = Arc::new(Db::open(&dir.join("archimedes.db")).expect("db opens"));
    let sink: Arc<dyn EventSink> = Arc::new(DiscardingSink);
    let mut manager = SessionManager::new(dir.to_path_buf());
    manager.attach_db(db.clone());
    manager.set_catalog(task_test_catalog());
    manager.set_sink(sink.clone());
    let manager = Arc::new(manager);
    let wm = {
        let m = manager.clone();
        let m2 = manager.clone();
        Arc::new(WorkerManager::new(
            Arc::new(TaskFixtureFactory),
            Arc::new(move |s: String, c: Option<i32>, p: Option<u32>| {
                m.on_worker_crash(&s, c, p);
            }),
            Arc::new(
                move |s: String, b: bool, e: crate::agent::worker::client::WorkerInboundEvent| {
                    m2.on_worker_event(&s, b, e);
                },
            ),
            Arc::new(|_s: &str| None),
        ))
    };
    manager.attach_worker_manager(wm.clone());
    (manager, wm, db, sink)
}

/// A `SessionInfo` for a stored row (the FK source `task_sessions.session_id`
/// points at — `Db::open` turns the `foreign_keys` pragma on, so a dangling
/// link id is refused at the statement).
fn stored_session(id: &str) -> SessionInfo {
    SessionInfo {
        session_id: id.to_string(),
        cwd: PathBuf::from("/tmp/task-session-link"),
        capabilities: serde_json::json!({ "loadSession": true }),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    }
}

/// Read the `task_sessions` rows through an INDEPENDENT connection to the same
/// SQLite file. `Db`'s `conn` is private and `storage/db.rs` is not this task's
/// to widen (A1 shipped no read API that takes the rows in this shape), so the
/// row is observed the way the file's own FK test observes a write: with a
/// second `rusqlite::Connection`.
fn link_rows(db_path: &Path) -> Vec<(String, String, Option<String>)> {
    let conn = rusqlite::Connection::open(db_path).expect("an independent connection");
    let mut stmt = conn
        .prepare(
            "SELECT task_id, session_id, stage_slug FROM task_sessions \
             ORDER BY session_id ASC",
        )
        .expect("prepares");
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .expect("queries");
    rows.collect::<Result<_, _>>().expect("maps")
}

/// (the link row, at the storage seam) `write_task_session_link` records
/// `(task, session, stage)`; an explicit stage is stored verbatim, `None`
/// resolves to the Task's CURRENT stage, and a missing Task is a deterministic
/// error naming the id rather than a dangling row.
///
/// Why the missing-Task case needs a check of its own when `Db::link_session`
/// already refuses one: that refusal fires only when it has nothing to resolve
/// (a `None` stage with no Task row to read the stage from). With an EXPLICIT
/// stage it would happily insert a row pointing at a Task that never existed —
/// `task_sessions.task_id` carries NO foreign key (ADR 0090), so SQLite will
/// not catch it. Hence the `get_task` gate at the command seam, pinned here.
#[tokio::test]
async fn write_task_session_link_records_the_row_and_defaults_the_stage() {
    let dir = ScratchDir::in_env_temp("cmd-task-link-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db opens");
    let space = "/cmd-task-link/space";
    let task = db
        .create_task(space, "Fix the flake", None, None)
        .expect("create");
    // The FK on `session_id` is live, so both ids need real rows.
    db.record_session(&stored_session("sess-explicit"))
        .expect("record 1");
    db.record_session(&stored_session("sess-default"))
        .expect("record 2");

    write_task_session_link(&db, &task.id, "sess-explicit", Some("research"))
        .expect("the explicit-stage link");
    write_task_session_link(&db, &task.id, "sess-default", None).expect("the default-stage link");

    let rows = link_rows(&dir.join("t.db"));
    assert_eq!(rows.len(), 2, "exactly the two link rows, nothing else");
    assert!(
        rows.contains(&(
            task.id.clone(),
            "sess-explicit".to_string(),
            Some("research".to_string())
        )),
        "the explicit stage is recorded verbatim: {rows:?}"
    );
    assert!(
        rows.contains(&(
            task.id.clone(),
            "sess-default".to_string(),
            Some("backlog".to_string())
        )),
        "`None` records the Task's CURRENT stage — `backlog`, the first default \
         stage `create_task` landed the card in: {rows:?}"
    );

    let err = write_task_session_link(&db, "tsk_missing", "sess-explicit", Some("doing"))
        .expect_err("a Task that does not exist is a refusal, not a dangling row");
    let message = err.to_string();
    assert!(
        message.contains("tsk_missing") && message.contains("not found"),
        "the rejection names the Task the caller has to fix: {message}"
    );
    assert_eq!(
        link_rows(&dir.join("t.db")).len(),
        2,
        "the refusal writes NOTHING (an explicit stage would otherwise have \
         inserted a row pointing at a Task that never existed)"
    );
}

/// (the end-to-end) `start_task_session_inner` starts a REAL Session through the
/// normal start path — the same `SessionManager::start_session` the plain
/// `start_session` command calls — attaches its Worker, and writes the ONE
/// `task_sessions` row.
///
/// THE load-bearing pin is `StartEnv.system_prompt == None`: spec §3's SPEC FIX
/// 2 is that a seed REPLACES the Worker's main prompt (the `(Fresh, Some(sp))`
/// arm of `worker/core.rs` never calls `build_main_prompt`, so a seeded Task
/// Session would be blind to its own `<tools>`, its skills, its `cwd` and
/// `AGENTS.md`). Reading the field the Worker actually received — off the
/// registry's stored env — is the only way to prove the command did not thread
/// one, because every other spelling of that claim is a byte-identical-file
/// check that a future edit inside this file could satisfy while doing damage.
///
/// And the Session is ORDINARY: `is_subagent = 0`, so `list_sessions` (which
/// filters only `is_subagent` / `archived`) lists it like any other main
/// session. A card's conversation is a sidebar row, not a hidden one.
#[tokio::test]
async fn start_task_session_inner_starts_a_session_and_writes_the_link() {
    let dir = ScratchDir::in_env_temp("cmd-task-session-", "cfg");
    let space = dir.join("space");
    std::fs::create_dir_all(&space).expect("the space dir");
    let (manager, wm, db, sink) = build_manager(&dir);
    let task = db
        .create_task(&space.display().to_string(), "Port the naming", None, None)
        .expect("create");

    let info = start_task_session_inner(
        &manager,
        db.clone(),
        &sink,
        space.clone(),
        task.id.clone(),
        None,
    )
    .await
    .expect("the Task's Session starts");

    assert!(!info.session_id.is_empty(), "a session id is minted");
    assert_eq!(
        info.cwd,
        std::fs::canonicalize(&space).expect("canonical"),
        "cwd is the canonicalized Space (the same canonicalization `start_session` \
         does before the Space row is touched — the join key)"
    );
    assert!(
        wm.test_is_attached(&info.session_id),
        "a Worker is attached — the Task's Session is a live one, not a row"
    );

    // THE no-seed pin (see the doc above): the envelope the Worker was started
    // with carries NO system prompt, so the Worker builds the real main prompt
    // at seq 0.
    let env = wm
        .test_env_for(&info.session_id)
        .expect("the registry holds the stored env");
    assert_eq!(
        env.system_prompt, None,
        "NO task context is seeded into `StartEnv.system_prompt` — a seed would \
         replace the main prompt and drop <tools>/skills/cwd (spec §3, SPEC FIX 2); \
         task context arrives as the first USER message (A5)"
    );
    assert!(
        matches!(env.mode, crate::agent::worker::protocol::StartMode::Fresh),
        "a Task's Session is a FRESH start, not a child start: {env:?}"
    );
    assert!(
        env.subagent_enabled,
        "an ordinary MAIN session (the Worker's `subagent` tool is available to it \
         — the value `start_session`'s own chain passes)"
    );

    // The ONE link row, read independently of `Db`.
    let conn = rusqlite::Connection::open(dir.join("archimedes.db")).expect("connection");
    let (row_task, row_session, row_stage): (String, String, Option<String>) = conn
        .query_row(
            "SELECT task_id, session_id, stage_slug FROM task_sessions WHERE task_id = ?1",
            [&task.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .expect("the link row exists");
    assert_eq!(row_task, task.id);
    assert_eq!(row_session, info.session_id);
    assert_eq!(
        row_stage.as_deref(),
        Some("backlog"),
        "`stage_slug: None` records the Task's current stage (what a later drag \
         into a `compact` column compacts FROM)"
    );
    let link_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM task_sessions WHERE session_id = ?1",
            [&info.session_id],
            |r| r.get(0),
        )
        .expect("counts");
    assert_eq!(link_count, 1, "ONE link row, not two");

    // An ordinary, usable Session: the row says main, so the sidebar lists it.
    let is_subagent: i64 = conn
        .query_row(
            "SELECT is_subagent FROM sessions WHERE id = ?1",
            [&info.session_id],
            |r| r.get(0),
        )
        .expect("the session row exists");
    assert_eq!(
        is_subagent, 0,
        "a Task-linked Session is an ORDINARY row — nothing is flagged, nothing \
         is hidden (`list_sessions` filters only is_subagent/archived)"
    );

    let _ = manager.close_session(&info.session_id).await;
    wm.reap_all().await;
}

/// (the abort path) a start that fails writes NO link row.
///
/// The order is the whole claim: `start_session` is awaited FIRST and the `?`
/// aborts before the link write is even attempted. The reverse order would leave
/// a `task_sessions` row pointing at a Session that was never born — and since
/// `task_sessions.task_id` has no foreign key, nothing downstream would notice.
/// A missing folder is the deterministic way to fail the start without touching
/// the Worker seam.
#[tokio::test]
async fn a_failed_start_writes_no_link_row() {
    let dir = ScratchDir::in_env_temp("cmd-task-nostart-", "cfg");
    let (manager, _wm, db, sink) = build_manager(&dir);
    let task = db
        .create_task("/cmd-task-nostart/space", "Never starts", None, None)
        .expect("create");

    let err = start_task_session_inner(
        &manager,
        db.clone(),
        &sink,
        dir.join("does-not-exist"),
        task.id.clone(),
        None,
    )
    .await
    .expect_err("a missing cwd fails the start");
    assert_eq!(
        err.kind(),
        "folder_missing",
        "the start's own error passes straight through, unmapped: {err}"
    );
    assert_eq!(
        link_rows(&dir.join("archimedes.db")),
        Vec::new(),
        "a failed start leaves NO link row"
    );
}

/// The command is registered in `lib.rs`'s `generate_handler!` list (the
/// ADR-0086 source-text pin precedent, `tests/provider_oidc.rs::
/// the_oidc_login_command_is_registered`). An unregistered command is a
/// `command start_task_session not found` in the app and NOTHING in the Rust
/// suite can see it, because `tests/ipc.rs` declares its OWN handler list.
/// `CARGO_MANIFEST_DIR` is `…/src-tauri`, so this reads `…/src-tauri/src/lib.rs`.
#[test]
fn start_task_session_is_registered_in_the_invoke_handler() {
    let lib = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("src/lib.rs reads");
    assert!(
        lib.contains("commands::tasks::start_task_session,"),
        "`start_task_session` is missing from lib.rs's generate_handler! list — the \
         wrapper would reject at runtime with `command not found`"
    );
}
