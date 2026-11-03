//! The `archimedes --worker` binary smoke test (ADR 0025 Task 2 —
//! INTEGRATION target: `env!("CARGO_BIN_EXE_archimedes")` is only
//! defined for `tests/` targets, NOT for in-file `#[cfg(test)]`
//! modules): the Worker mode starts WITHOUT the Tauri runtime (the
//! flag is checked before the Tauri init — the Tauri runtime never
//! starts in a Worker), emits a `hello` JSON line (the protocol
//! version) then a `ready` one (the binary version), and exits 0 on a
//! `close` line / stdin EOF.

use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::time::Duration;

/// Spawn the built binary in Worker mode (the Tauri runtime never
/// starts — the `--worker` flag is checked before the Tauri init).
fn spawn_worker() -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(env!("CARGO_BIN_EXE_archimedes"));
    cmd.arg("--worker");
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());
    cmd
}

/// Read the two handshake lines: `hello` (the protocol version — the
/// Fulcrum T1 opener) then `ready` (the binary version). Bounded, so a
/// missing frame is a test failure, not a hang.
async fn read_ready_line(child: &mut tokio::process::Child) -> serde_json::Value {
    let stdout = child.stdout.take().expect("stdout is piped");
    let mut reader = tokio::io::BufReader::new(stdout);
    // Line 1: the version-negotiation opener.
    let hello = read_line(&mut reader).await;
    assert_eq!(
        hello["type"], "hello",
        "the FIRST stdout line is the `hello` discriminator"
    );
    assert_eq!(
        hello["protocolVersion"], 1,
        "the `hello` frame carries the protocol version: {hello}"
    );
    // Line 2: the `ready` frame, unchanged.
    let ready = read_line(&mut reader).await;
    assert_eq!(
        ready["type"], "ready",
        "the `hello` frame is immediately followed by `ready`"
    );
    ready
}

/// Read one stdout line as JSON (bounded).
async fn read_line(
    reader: &mut tokio::io::BufReader<tokio::process::ChildStdout>,
) -> serde_json::Value {
    let mut line = String::new();
    let n = tokio::time::timeout(Duration::from_secs(15), reader.read_line(&mut line))
        .await
        .expect("the handshake line arrives within the bound")
        .expect("stdout is readable");
    assert!(n > 0, "a handshake line is present");
    serde_json::from_str(line.trim()).expect("the handshake line is JSON")
}

/// Spawn → `ready` → a `close` line → exit 0.
#[tokio::test]
async fn worker_ready_then_close_exits_zero() {
    let mut child = spawn_worker().spawn().expect("the worker starts");
    let ready = read_ready_line(&mut child).await;
    assert!(
        ready["version"].is_string(),
        "the ready frame carries the binary version: {ready}"
    );
    // The `close` line (the `Inbound::Close` wire form).
    let stdin = child.stdin.take().expect("stdin is piped");
    let mut stdin = tokio::io::BufWriter::new(stdin);
    stdin
        .write_all(b"{\"type\":\"close\"}\n")
        .await
        .expect("the close line is written");
    // `BufWriter` buffers — flush so the Worker actually sees the line
    // (the test holds the writer open until the end — the Worker exits
    // on the `close` line itself, NOT on the stdin EOF).
    stdin.flush().await.expect("the close line is flushed");
    let status = tokio::time::timeout(Duration::from_secs(15), child.wait())
        .await
        .expect("the worker exits after the close line")
        .expect("the worker process ends");
    assert!(status.success(), "close → exit 0, got {status}");
}

/// Every frame the REAL Worker writes after a `start` carries a monotonic
/// `frameSeq`, and the two handshake frames carry NONE.
///
/// WHY THIS IS HERE AND NOT ONLY IN `protocol.rs`: the unit tests pin
/// `stamp_outbound` in isolation, so a writer that quietly went back to
/// `encode_outbound` — the pump task, the crash task, or `write_frame` —
/// would keep every one of them green while the cursor vanished from the
/// wire. T2's `attach { afterSeq }` reads exactly this field, so the
/// writer-side pin needs a real process behind it.
#[tokio::test]
async fn every_frame_after_start_carries_a_monotonic_frame_seq() {
    let mut child = spawn_worker().spawn().expect("the worker starts");
    // Take stdin BEFORE the handshake helper — it `take`s `stdout`, and
    // both handles are needed here (write a `start`, then keep reading).
    let stdin = child.stdin.take().expect("stdin is piped");
    let stdout = child.stdout.take().expect("stdout is piped");
    let mut reader = tokio::io::BufReader::new(stdout);

    // The handshake: `hello` then `ready`, NEITHER stamped — the cursor
    // numbers a SESSION, and these two precede one.
    let hello = read_line(&mut reader).await;
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["protocolVersion"], 1);
    assert!(
        hello.get("frameSeq").is_none(),
        "the pre-session `hello` carries no cursor: {hello}"
    );
    let ready = read_line(&mut reader).await;
    assert_eq!(ready["type"], "ready");
    assert!(
        ready.get("frameSeq").is_none(),
        "the pre-session `ready` carries no cursor: {ready}"
    );

    let mut stdin = tokio::io::BufWriter::new(stdin);
    // A `start` the Worker ACCEPTS. A `start` that failed to decode is
    // dropped permissively and would leave ZERO stamped frames — the
    // assertion below would then be vacuously true, hence the explicit
    // "at least three frames" bound and the stderr hint.
    stdin
        .write_all(start_line().as_bytes())
        .await
        .expect("the start line is written");
    stdin.flush().await.expect("flushed");

    let mut seen: Vec<u64> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while seen.len() < 3 && tokio::time::Instant::now() < deadline {
        let mut line = String::new();
        let read = tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line)).await;
        match read {
            // A stalled read: keep polling until the outer deadline.
            Err(_) => continue,
            // EOF — the Worker is gone; stop (the "at least three"
            // bound below turns a too-early exit into a failure).
            Ok(Ok(0)) => break,
            Ok(Ok(_)) => {}
            // A read error: the pipe is dying — stop for the same reason.
            Ok(Err(_)) => break,
        }
        let trimmed = line.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        let v: serde_json::Value =
            serde_json::from_str(&trimmed).expect("every stdout line is JSON");
        let seq = v["frameSeq"].as_u64();
        assert!(
            seq.is_some(),
            "a post-`start` frame carries `frameSeq`: {v}"
        );
        seen.push(seq.expect("checked above"));
    }

    assert!(
        seen.len() >= 3,
        "at least three stamped frames arrived (fewer means the `start` \
         never decoded and this test proved nothing): {seen:?}"
    );
    assert_eq!(seen[0], 1, "the cursor starts at 1 for the session");
    for pair in seen.windows(2) {
        assert_eq!(
            pair[1],
            pair[0] + 1,
            "the cursor is monotonic and contiguous: {seen:?}"
        );
    }

    let _ = child.kill().await;
}

/// A `start` envelope the Worker decodes, in wire form.
///
/// The casing is NOT uniform and that is the tree's, not a mistake:
/// `StartEnv` is camelCase (its own `rename_all`), but `Model` /
/// `ModelCatalog` / `CompactionConfig` carry NO `rename_all` at all, so
/// their fields are snake_case on the wire. A camelCase `model` block
/// fails to decode, the Worker drops the line permissively, and the test
/// above silently sees zero frames.
fn start_line() -> String {
    let model = serde_json::json!({
        "id": "m1", "provider": "fake", "base_url": "http://127.0.0.1:1/v1",
        "api_key": "k", "context_window": 100_000, "cost_per_mtok_in": 0.0,
        "cost_per_mtok_out": 0.0, "supports_tools": true, "supports_thinking": false,
        "thinking_levels": [], "api": "openai-completions"
    });
    let catalog = serde_json::json!({
        "models": [model], "default_model": null,
        "compaction": {
            "enabled": true, "reserve_tokens": 16384, "keep_recent_tokens": 20000
        }
    });
    let body = serde_json::json!({
        "type": "start", "sessionId": "s-smoke", "cwd": "/tmp", "mode": "fresh",
        "transcript": null, "model": model, "catalog": catalog, "thinking": null,
        "trusted": true, "enabledTools": ["bash"], "permission": null,
        "configDir": "/tmp/archimedes-smoke", "subagentEnabled": false,
        "systemPrompt": null, "incarnation": "a1"
    })
    .to_string();
    // The JSONL framing is NOT optional: the Worker's stdin reader blocks
    // in `read_line` until the `\n` arrives, so an unterminated line is a
    // Worker that never starts and a test that times out.
    format!("{body}\n")
}

/// Spawn → `ready` → NO `close`, just EOF (close stdin) → exit 0 (the
/// clean-EOF path).
#[tokio::test]
async fn worker_stdin_eof_exits_zero() {
    let mut child = spawn_worker().spawn().expect("the worker starts");
    let _ready = read_ready_line(&mut child).await;
    // No `close` — just EOF (drop the stdin handle).
    drop(child.stdin.take().expect("stdin is piped"));
    let status = tokio::time::timeout(Duration::from_secs(15), child.wait())
        .await
        .expect("the worker exits on stdin EOF")
        .expect("the worker process ends");
    assert!(status.success(), "stdin EOF → exit 0, got {status}");
}
