# Known flakes

Every flake this repo has observed, with the evidence that identifies it and the
instruction to **re-run before investigating**. None of these is a drive-by fix.

Read this file when a test goes red and the diff does not plausibly reach it. The
discriminator for most entries is the same: **a failure at a commit whose diff
cannot reach the failing test is proof of a load flake, and the check is one
command** — `git show --stat --format="" <sha>` — so run it before reading the
assertion.

Two rules apply to every entry here:

- **Cite a flake by CI run ID, not by head SHA.** After squash-merge the
  per-issue commits are unreachable from `main`, so `gh run view <id>` is the
  durable handle (see the squash-orphan entry in `repo-gotchas.md`).
- **Match on the test NAME, never the line number.** Every line number these
  entries once recorded has already moved; the quoted assertion is the part that
  survives the object.

- **`src/components/MessageBubble.codeblock.test.tsx`'s
  `renders a \`%s\` fence genuinely highlighted` (the `it.each` JSON case) flakes**
  — it intermittently renders the unhighlighted fallback through shiki's async
  path. Pre-existing, unrelated to whatever you just changed: if it fails once,
  re-run before investigating. It needs an owner, not a drive-by fix.
- **`src-tauri/tests/worker_e2e.rs::subagent_dispatch_end_to_end_real_workers` flakes, is
  undocumented elsewhere, and needs an owner — not a drive-by fix.** It intermittently fails
  `the subagent dispatch Completed (not Failed), got {"isError": true, "text": "subagent failed:
  the subagent settled with no output"}` — a real-worker spawn that settles before its output
  rendezvous. **Five observations, one per OS leg** — CI runs `41052924099` (macOS), `41188804029`
  (macOS, PR #137), `41228486025` (macOS, PR #140), `41054872558` (Windows) and `41280792380`
  (ubuntu, PR #142 — which then PASSED on re-run at the same SHA). Cite these run IDs, not the head
  SHAs: four of the five are unreachable from `main` (one is not even a local object), which is the
  squash-orphan trap this file already records — `gh run view <id>` is the durable handle, and the
  quoted assertion above is the version that survives the object. Only PR #142's case is verified
  Rust-free in its diff; the older four were not audited. But three OSes and five unrelated
  checkouts is not one branch's bug, and same-SHA pass/fail across legs is the load signature.
  So re-run the job before
  investigating, and do not go hunting for a Rust fix when the diff is TypeScript. Note the
  assertion's line number moves with the file (`:1287` and `:1314` were both observed) — match on
  the test name, never the line.
- **`src-tauri/tests/worker_e2e.rs::the_definition_permission_deny_refuses_the_child_real_worker`
  flakes too — a SECOND test in that file, distinct from the one above, and it needs an owner.**
  It fails at `assert!(!sub_is_error, "the dispatch Completed (the refusal is inside the capture),
  got {sub_result:?}")` — the same real-worker rendezvous shape as `subagent_dispatch_end_to_end_real_workers`,
  in a different test, so the file has TWO flaky real-worker dispatch tests and fixing one will not
  fix the other. **Two observations: CI runs `43881764169` (ubuntu, `push`, at `ad86d157` / PR #200's
  squash) and `43787599220` (ubuntu, `push`, at `74e38fa1`).** Cite the run IDs, not the SHAs, per the
  squash-orphan rule. **The load signature here is stronger than a same-SHA split, and it is the one
  that settles it: `74e38fa1` is a DOCS-ONLY commit** — `git show --stat` on it is one file,
  `docs/features/anthropic-output-ceiling-known-gaps.md`, +158 lines — and a markdown file cannot break a
  real-worker permission test. When a red appears at a commit whose diff cannot reach the failing test,
  that is the proof, and the check is one command (`git show --stat --format="" <sha>`), so run it before
  reading the assertion. The `ad86d157` case was additionally proven by tree-identity: its tree is
  byte-identical to `c22936db`, which had already passed all three OS legs on BOTH its `push` and
  `pull_request` runs. **`gh run rerun <id> --failed` went green on the first attempt both times.**
  Unlike the bullet above, this one did NOT co-occur with the temp-dir census guard (`grep -c` over the
  failed log printed `0`), so a red here is one incident and nothing else needs explaining.
- **The `cargo test` temp-dir guard (`the Rust test suite left N new directories in … — #96's leak
  is back`) is often a CONSEQUENCE of the `worker_e2e` flake above, not a second failure.** Seven
  observations (runs `41052924099`, `41187113475`, `41188776833`, `41192896331`, `41195614333`,
  `41225507859`, `41228486025`), every one on `macos-latest` — though the CI
  step is `if: runner.os != 'windows'`, so it runs on ubuntu too and has simply never tripped there.
  Measured overlap: of the five runs where `subagent_dispatch_end_to_end_real_workers` failed, two
  (`41052924099`, `41228486025`) ALSO tripped the guard in the same job — a killed-or-abandoned
  real-worker spawn leaves its temp
  dir behind. So read a red guard on a run that also failed that test as one incident, not two, and
  do not go looking for a new leak on the branch under review. It is a distinct mechanism from the
  `check-temp-dir-census` case-13 bullet below (that is the script's own `--self-test` on Linux
  `/tmp`; this is the CI wrapper around `cargo test` on macOS's per-user `$TMPDIR`), and the
  guard's own message names #96 as the leak it exists to catch.
- **`Reasoning.test.tsx`'s `is O(last line), not O(whole text)` is a wall-clock
  assertion and flakes under full-suite load.** It measures
  `performance.now()` for a big input vs a small one and requires the ratio to be
  under 50, so a loaded machine or a GC pause can tip it — it passes in isolation
  and failed once on `main` right after an unrelated merge. Same advice: re-run
  before investigating, and do not "fix" it by tightening or loosening the
  threshold, which only moves the flake.
- **`harness::provider::transport::tests::a_slow_stream_completes_but_a_silent_stream_errors`
  flakes on ubuntu and needs an owner — not a drive-by fix.** It dribbles one body byte every
  **50 ms** against a **200 ms `read_timeout`** and asserts the dribbling stream COMPLETES while a
  silent one ERRORS, so a scheduler stall longer than the 150 ms margin reads as "the slow stream
  was cut". **Two failures, one per CI event type, in two runs of PR #158:** run
  **`41944729705`** (a `pull_request` run) failed while its sibling `push` run at the same SHA
  passed; then run **`41947586793`** (a `push` run) failed on **attempt 1** and went green on the
  re-run, while its sibling `pull_request` run `41947592114` passed at that same SHA. **That
  cross-event split at an unchanged SHA is the load signature** — cite these run IDs, not the SHAs,
  per the squash-orphan rule below. **Passed on re-run both times.** **Pre-existing, not
  introduced by the crate extraction** — verified by diffing the test body against
  `origin/main:src-tauri/src/agent/harness/provider/transport.rs`: **0 differing lines**, only its
  path moved (`agent/harness/` → `crates/fulcrum-core/src/harness/`). Same advice as the two above:
  re-run before investigating, and do not touch the 50/200 ms thresholds, which only moves the flake.
- **`scripts/check-temp-dir-census.test.sh` case 13 (`--self-test leaves the real
  census base unchanged`) reddens on a loaded Linux box, and the assertion is
  correct.** Its metric is `count_entries` — `find /tmp -mindepth 1 -maxdepth 1`,
  **every** depth-1 entry, not just directories, so on a dev box it is in the
  hundreds (~729 measured here) rather than the ~130 a directory-only count gives.
  `/tmp` here is a **tmpfs** shared with everything else on the machine, so anything
  else creating a temp dir mid-run legitimately violates the assertion. It moved
  twice (686→683, 697→694) during a wave that ran three agents in one tree with two
  cold `cargo build --all-targets` in flight — those two figures come from the agent
  that hit them, not from a re-measurement, but their magnitude agrees with the ~729
  above, so they are the same metric. On a quiet box the count was stable at 729
  across six samples. So re-run before investigating, and do not "fix" it by
  loosening the assertion — the churn is a real violation, and CI's `/tmp` does not
  churn. If it ever bites CI, the honest fix is a dedicated temp root for the census,
  not a wider tolerance.
- **`agent::childproc::tests::tool_child_reads_eof_on_closed_stdin` flakes on Windows and needs
  an owner — not a drive-by fix.** Observed failing on CI's `windows-latest` leg while
  `childproc.rs` was untouched by the branch under review, passing on the other run of the same
  SHA and on all runs of the next push. Its own docblock already says why: *"A regression pin,
  not the proof. On a host where cargo's own stdin is already `/dev/null` — which is what a CI
  step gets — this test passes with OR without `closed_stdin`."* So its pass/fail depends on the
  inherited handle, and the behaviour proof lives in the `execute_tool` test that re-execs the
  binary with a real pipe. Re-run before investigating.
- **`src-tauri/tests/provider_gcloud_adc.rs` flakes under concurrent load — this file names it once
  already, but only as a source-text-lint MOVE HAZARD (the "Moving a file between the two packages"
  bullet below), never as a flake — and it needs an owner, not a drive-by fix.** Two of its
  tests intermittently fail with
  `left: None` where an ADC-minted bearer was expected: `env_override_beats_the_provider_flag`
  (`assertion \`left == right\` failed: an unrecognised env value defers to the provider flag`,
  `right: Some("ya29.env-token")`) and `resolve_bearer_serves_the_minted_adc_token` (`the ADC token
  is the effective bearer`, `right: Some("ya29.arm-token")`). **Three observations on 2026-11-14,
  two distinct tests.** The run logs were in `/tmp` and are ephemeral, so per the squash-orphan rule
  above the quoted assertions are the durable handle, not the paths or the lines. Match on the test
  NAME: the file is byte-identical to `main` (below), which is why both
  `resolve_bearer_serves_the_minted_adc_token` panics landed on the same `provider_gcloud_adc.rs:337`
  — the line is not evidence of anything and it moves the moment the file is edited.
  **Pre-existing, not this branch's, and no storage change can reach it.** `git log main..HEAD --
  src-tauri/tests/provider_gcloud_adc.rs` prints nothing and `git diff --stat main...HEAD --` that
  same path prints nothing — identical to `main` — and the file has zero database contact:
  `grep -cE 'Db::open|rusqlite|Connection' src-tauri/tests/provider_gcloud_adc.rs` → **0** (and
  case-insensitive `sqlite` and `\bDb\b`: also 0). So do not go hunting for a storage fix here.
  **The load signature is a correlation, not a discriminator — and the control run refutes it.** The box
  is 8 cores (`nproc`). All three failures overlapped a `vitest` run. In two of them the cargo log's last
  write lands inside the paired `pnpm test`'s window — 16:01:14 against a `Start at 16:01:04` for a 130 s
  run, and 17:46:28 against a vitest ending 17:48:28 — and `provider_gcloud_adc` is that cargo run's LAST
  target, so its tail executed while vitest was running. The third (a cargo run ending 14:55:50) overlaps
  a vitest in a SIBLING worktree, and that one is a **weak** witness: it did not run the app's suite at
  all, it **failed on module resolution** (`Cannot find package '@earendil-works/pi-tui'`; 103 of its 154
  test files failed, only 38 tests actually failed while 868 passed, and the whole run lasted 24 s against
  the ~130–138 s a real `pnpm test` takes here), so it applied far less load than a full 187-file run. **The control
  run breaks the theory outright: a run in THIS tree PASSED 979/0 across 39 test binaries with every one
  of this file's 14 tests `ok` (`test result: ok. 14 passed; 0 failed`), and its cargo test phase sits
  entirely inside its own vitest window.** Reconstruct such a window without timestamps by summing the
  per-target `finished in N s` lines — 58.3 s over that run's 40 `test result:` lines (39 test binaries
  plus one doc-test) — and subtracting from the log's mtime: 15:54:16–15:55:15 against a vitest window of
  15:54:02–15:56:20. So concurrency plausibly raises the odds and is nowhere near sufficient; a 981/0 run
  probably overlapped too but its vitest log survives only as a 60-byte tail with no `Start at`, so that
  is not provable. **Two runs are provably alone: a 981/0 at 18:28:10 and a 1003/0 at 20:01:46.** "Alone"
  means no other SUITE ran alongside, so check it on suite-ness, not on any-file-in-`/tmp` — list the `.log`
  files in the window and show which carry a `cargo test` result:

  ```bash
  alone() {   # alone <window-start> <window-end>
    find /tmp -maxdepth 1 -name '*.log' -newermt "$1" ! -newermt "$2" -printf "%T+ %p\n" | sort |
      while read -r t f; do printf "%s %-26s test-result-lines=%s\n" "$t" "$(basename "$f")" \
        "$(grep -ac 'test result:' "$f" 2>/dev/null)"; done
  }
  alone "2026-11-14 18:10:00" "2026-11-14 18:45:00"   # around the 18:28:10 run
  alone "2026-11-14 19:31:46" "2026-11-14 20:31:46"   # around the 20:01:46 run
  ```

  Around 18:28:10 (window `18:10`–`18:45`) that prints **one line** — the run's own log, 40 result lines.
  Around 20:01:46 (window `19:31:46`–`20:31:46`) it prints three, and only the run's own log plus a second
  1003/0 at 20:16:04 carry `test-result-lines=40`; the third is a clippy capture with `0`, which is not a
  suite. **Run that check yourself before repeating this sentence:
  these logs are ephemeral and the day they are gone the sentence is unfalsifiable, which is exactly why the
  assertions up top are the durable handle.** Two corrections while I am here, both to claims this bullet
  used to make: the clippy log it named as "the only thing between" the two 1003/0 runs is in fact dated
  19:48:25, **before both of them** (so it was not between them at all, and the claim was right by accident),
  and `/tmp` was **not** empty between 17:50 and 18:35 — three non-suite entries are dated inside that window
  — though no second SUITE log is, which is all the claim ever needed. Corollary, and it
  bit once already: **all three failing runs are 26-target and all three passing runs are 39-target.**
  Cargo's fail-fast stops the binary list at `error: test failed, to rerun pass \`--test
  provider_gcloud_adc\``, so the 13 targets after it (`worker_e2e`, `storage`, `skills`,
  `provider_oidc`, …) never ran. A 26-target `cargo test` log is a TRUNCATED run, not a smaller
  suite, and its 856/857/859 totals are not comparable to 981/1003.
  **CI is safe and cannot hit this, so a red on CI is never "unexplained" here.**
  `.github/workflows/ci.yml` holds two jobs; `cargo test` and `pnpm test` are sequential STEPS of
  the one `lint-test-build` job (the three `cargo test` steps are mutually exclusive —
  `if: runner.os == 'linux'`, `'macos'`, `'windows'` — and `pnpm test` is a later step of that same
  job), and the `scripts` job runs neither. Running the two suites at once is the only reproduction
  anyone has, but read the paragraph above first: it raises the odds and does not reliably
  reproduce.
  **The mechanism this file's sibling doc carries does not fit the evidence — start there.**
  `docs/features/improvement-boundary-residue-closeout.md` §7 names this file's flake (that entry is
  the only prior documentation, and it names `env_override_beats_the_provider_flag` alone) and
  attributes it to "process-global `LITELLM_GCLOUD_TOKEN_AUTH` bleed under parallel harnesses". That
  cannot explain `resolve_bearer_serves_the_minted_adc_token`, which never touches that variable;
  and intra-process bleed is excluded by construction, because every env-mutating test in the file
  holds the SAME `test_support::ENV_LOCK` whether it spells it `env_lock()` or `adc_serial()`, so
  they are mutually exclusive — and the lib-test binary that also drives the override
  (`agent/session/tests/mod.rs`) is a different PROCESS holding its own copy of that static, so a
  cross-binary env bleed is arithmetically impossible. What the evidence does fit: both failures are
  a MINT resolving to `None` and the target binary reports `finished in 0.05–0.08 s` — far inside the
  `HTTP_TIMEOUT` of **30 s** that `fulcrum-harness`'s `provider_auth/gcloud.rs` sets (line 47 at the pinned
  **0.3.3**; re-check it on any bump, since the constant lives in the published crate and NOT in this tree —
  `grep -rn HTTP_TIMEOUT src-tauri/src src-tauri/tests` prints nothing), so the ADC leg failed fast rather than timing out:
  an absent-or-unreadable ADC file, a
  parse rejection, or a refused POST to the in-process `wiremock` server under CPU starvation. Both tests
  that mint can lose; the tests that assert `None` cannot, which is why they never show up here.
  **The two bare-lock tests, located by content, and the trap in the obvious fix.**
  `env_override_beats_the_provider_flag` and `token_is_none_when_no_adc_file_exists_anywhere` are the
  only two of the file's twelve `#[tokio::test]`s that take a bare `env_lock()`; the other ten split
  **9 on `adc_serial()`** and one (`the_refresher_passes_a_gcloud_adc_credential_through_unchanged`)
  on neither, correctly, because it mutates no env. Both bare-lock tests mutate process-global state
  (`HOME`, `LITELLM_GCLOUD_TOKEN_AUTH`, `gcloud::ADC_ENV_VAR`) across `.await`s. But moving both onto
  `adc_serial()` is WRONG for the second, and that is the trap: `adc_serial()` installs
  `AdcFileSource::Explicit(None)`, which REPLACES discovery, so running
  `token_is_none_when_no_adc_file_exists_anywhere` — whose entire subject is the PRODUCTION discovery
  path over a scratch `HOME` — through it would pass having tested nothing. And a second bare
  `env_lock()` in one thread deadlocks: the file's own note on
  `an_ordinary_row_never_touches_the_adc_flow` records `ENV_LOCK` as a non-reentrant
  `std::sync::Mutex` and calls that "the one way this suite can hang". So the real fix is a
  thread-local override (or a reentrant-aware serialization), not a re-lock. **Isolation is green —
  the close-out records `env_override_beats_the_provider_flag` as green standalone 3× and green as a
  target 3×, green on the next 4 full runs — but those runs left no artifact I could find (no
  single-target `cargo test` log survives in `/tmp`), so that figure is the close-out's, not a
  re-measurement here.** Re-run alone before investigating.

- **`commands::settings::tests::provider_login_oidc_surfaces_the_manual_url_when_the_callback_fails`
  flakes on ubuntu with `EADDRINUSE`, and it is NOT yet fixed — it needs an owner.** It fails
  `assertion failed: message.contains("authorize manually at:")` with the preceding line reading
  `every configured redirect port failed to bind (no redirect ports were configured); the ephemeral
  fallback failed too: could not bind the OIDC callback listener: Address already in use (os error 98)`.
  So the test's own fallback bind loses a race for an ephemeral port and the manual-URL branch it
  asserts never runs. **One observation: CI run `45569694538` (ubuntu, `push`), which PASSED on
  re-run at the same SHA.** Cite the run ID, not the SHA, per the rule above.
  **The load signature is the strongest in this file and it is worth naming as a template: that run
  failed a DIFFERENT test on each of its first two attempts** — attempt 1 this OIDC port bind, attempt
  2 `the_definition_permission_deny_refuses_the_child_real_worker` (a registered entry above) — at an
  unchanged SHA whose entire diff was one `.gitattributes` file. Two unrelated reds at one commit, and
  a diff that is a checkout-normalisation file, cannot both be the commit's fault. `git show --stat`
  settles it in one command.
  **Do not read this as a Windows finding.** It appeared on the ubuntu leg while the Windows leg at
  that same SHA was green; the `.gitattributes` change that was under test affects checkout only.
  One consequence is worth knowing before triaging anything in that job: because `cargo test` fails
  fast, an `EADDRINUSE` here silently skips `pnpm test` and `pnpm build` on that leg, so a red here
  also means "the frontend never ran here" — check the step list rather than assuming coverage.

- **`agent::session::tests::resolve_derives_anthropic_messages_wire_for_claude_route`
  flakes on macOS — a THIRD test whose subject is a local HTTP probe, and it needs an
  owner.** Its assertion, quoted because line numbers move and this does not:
  `assertion \`left == right\` failed: a Claude-adapter route with the messages probe
  passing derives the Messages wire / left: Some("litellm") / right:
  Some("anthropic-messages")`. The mechanism is a race, not a logic error: the test
  starts a local `litellm_server` and points a provider at it, and the one-time
  `GET /v1/messages` liveness probe's **2xx is the latch's only evidence** that the
  Messages wire is available — so a probe that does not answer in time is read as
  "Messages not available" and the route correctly, deterministically derives the
  `litellm` fallback. The test asserts the opposite branch. A slow probe is therefore
  a GREEN-shaped outcome reached by a real code path, which is why it is load-sensitive
  rather than merely slow.
  **One observation: CI run `45611911727` (macOS, `push`), which PASSED on re-run at
  the same SHA.** Cite the run ID, not the SHA, per the rule above.
  **The load signature is the cleanest available and is worth naming: at that one SHA
  the ubuntu, Windows and Shell-scripts legs were all GREEN and only the macOS leg was
  red**, on a branch whose entire Rust surface was zero files (`git diff --name-only
  main...HEAD | grep -c src-tauri` → `0`). Same tree, three legs pass, one fails, diff
  cannot reach it — both discriminators this file's header names, in one run.
  **Do not go looking for a Rust fix when the diff is TypeScript.** And unlike the
  `worker_e2e` entries above, this one does NOT co-occur with the temp-dir census
  guard: on that run the census step passed and only `cargo test` failed, so a red
  here is one incident and nothing else needs explaining.
