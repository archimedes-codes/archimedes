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

- **`src/lib/paletteTestKit.test.ts`'s four discovery tests fail TOGETHER, all with the identical
  `src/styles/guardprobe.css cannot be read — a Palette spec must name a CSS file it owns` — a LOCAL
  cross-worker plant/delete race, and it needs an owner, not a drive-by fix.** **It bit LOCALLY, on a
  desktop `pnpm test`, not on a CI leg** — so there is no run ID to cite and `gh run view` is the wrong
  tool; check your own terminal first. It is a LOCAL entry in the sense that rule #1 above cannot serve
  it: there is no run to view. The `check-temp-dir-census` case-13 bullet and the `provider_gcloud_adc`
  bullet above are local on their own text too — case-13 churns a `/tmp` CI does not have, and
  `provider_gcloud_adc` is local-only by construction because CI *cannot* hit it (see its "CI is safe"
  paragraph) — but unlike both, this one needs no load at all. It is also the **only entry here whose
  mechanism is a test writing into this repo's own working tree**: every other local or load entry
  churns `/tmp`, a scratch `HOME`, a process-global env, or a local port, whereas this plant is a
  TRANSIENT UNTRACKED file inside tracked directories — visible to a filesystem walk (`grep -rln`) and
  invisible to `git ls-files`, which cannot see an untracked path even while it exists.
  The four tests, named in file order because you must match on the NAME:
  `every row's modes match its blocks, and every registry mode is graded`,
  `every row declares its own id and its own CSS file`,
  `grades every shipped Palette clean, so the harness is not simply broken`, and
  `grades every graded text token in every Palette — a Palette cannot shrink the set`.
  **Every `path:NNN` below is dated provenance, not a match key** — measured at `61c2e19d`, where every
  one of them resolves (and still resolving at the tree this entry was written in). Rule #2 above is the
  one that governs: the four NAMES are how you match this flake, and the line numbers are the part that
  moves.
  **THE TELL, which is cheap and recognisable: all four fail with the SAME message, and it names
  `guardprobe`.** It is thrown by `readCssFile` (`src/lib/paletteTestKit.ts:72`; the message literal
  is at `:73`) from the palette-discovery walk and from `gradePalette`
  (`src/lib/paletteTestKit.ts:568-569`, which reads `spec.cssFile` and `spec.baseCssFile`). If you see
  one of those four red alone, it is not this. If you see **all four** red with that one string, stop
  reading assertions and re-run.
  **The cause is a race between two vitest WORKERS, not load and not timing sensitivity.**
  `src/lib/paletteCompleteness.test.ts` runs a live guard that PLANTS a fake Palette into the real
  swept directory — `src/lib/palettes/guardprobe.ts` + `src/styles/guardprobe.css`
  (`GUARD_TS`/`GUARD_CSS` at `:3020-3021`) — writes them at `:3069-3070` and `:3080-3081`, and removes
  them in a `finally` at `:3233-3234`, with a further delete in `beforeEach` at `:3107` and a
  boot-time cleanup of both paths at `:84-85`. It cannot write anywhere else and still test discovery.
  `paletteTestKit.test.ts` takes its discovery snapshot ONCE, at module scope
  (`const specs = await listPaletteSpecs()`, `:44`), and discovery excludes nothing —
  `specFileNames`' filter is `/^[a-z][a-z0-9-]*\.ts$/` (`src/lib/paletteTestKit.ts:309`) and
  `guardprobe.ts` matches it. `vite.config.ts:40-43` sets `environment: "jsdom"` and overrides neither
  `fileParallelism` nor `maxWorkers`, so vitest builds one environment per file and runs these files in
  parallel workers, and the window is real.
  **CORRECTION TO THE OBVIOUS STORY, and it matters because it decides what the fix is: the hazard is
  NOT "the `.ts` row exists while the `.css` does not".** That interleaving is not reachable from this
  code's ordering — the plant writes **CSS first** (`:3069`) and the delete removes **TS first**
  (`:3050`), so the `.css` is the last thing to go and the first thing to arrive. The window that
  actually produces the error is the SNAPSHOT OUTLIVING THE PLANT: discovery captures the `guardprobe`
  row while both files exist, the guard's `finally` then removes them, and the four tests later read
  `cssFile` off a row they are already holding. The `.ts` being gone is irrelevant by then — the row
  survives in the snapshot, and `readCssFile` hits the deleted `.css`. **Consequence: "make the plant
  atomic" does NOT close this.** A perfectly atomic plant still leaves a snapshot holding a row whose
  CSS is deleted afterwards. What closes it is giving the guard its own file set that discovery cannot
  enumerate (or excluding the probe from discovery) — real work, with a blast radius wider than it
  looks: `grep -rln guardprobe src/ scripts/` measures **ten files** today
  (`paletteCompleteness.test.ts`, `paletteTestKit.ts`, `paletteTestKit.test.ts`, `sourceSweep.ts`,
  `sourceSweep.test.ts`, `layerBoundary.test.ts`, `classNameConvention.test.ts`,
  `themeTokens.test.ts`, `tauriBarrel.test.ts`, `tauriBoundary.test.ts`), and seven of them carry a
  vanished-path tolerance written for this probe (`layerBoundary.test.ts:139`/`:343`/`:389`,
  `classNameConvention.test.ts:113`/`:330`, `themeTokens.test.ts:836`/`:1365`/`:1408`,
  `tauriBarrel.test.ts:61`, `tauriBoundary.test.ts:86`, `paletteTestKit.ts:323`/`:382`, and
  `sourceSweep.ts:17`, which is the tolerance's definition rather than a second copy of it). The other
  three do not carry one: `paletteTestKit.test.ts` deliberately reads with `named()`, not `listed()`
  (`:22-23`), so its pin goes red rather than skipping, `sourceSweep.test.ts` drives the mechanism on
  `.tmp` probes it plants itself, and `paletteCompleteness.test.ts` routes its `.tsx` sweep through the
  reader for uniformity, not for its own probe — its header at `:101-108` says so out loud. **The hazard
  is therefore already documented in-repo and only TOLERATED, never closed** —
  `paletteTestKit.test.ts:668` and `paletteTestKit.ts:316` both name the other-worker plant/delete
  explicitly, and `sourceSweep.ts:8-23` exists precisely because seven gates list-then-read a tree
  another worker is churning. What that machinery catches is a path that VANISHED before it was
  opened; `readCssFile` is a bare `readFileSync` in a `try`/`catch` (`:68-76`) with no vanished-path
  tolerance at all, which is why the probe's CSS throws instead of being skipped.
  **Why the failure count is EXACTLY FOUR, and the arithmetic corroborates the diagnosis:** six tests
  in the file iterate that snapshot, but only these four read CSS from it — `:304`, `:347`, `:353`
  (via `gradePalette`) and `:642`/`:644`. The other two (`discovers one row per Palette the registry
  offers` at `:233`, `discovers AT LEAST the two shipped Palettes…` at `:277`) only map over `spec.id`,
  and an extra `guardprobe` id passes both by design — `:239-248` records that the
  directory-may-exceed-registry direction was deliberately removed, so a surplus row is legal. Four CSS
  readers, four failures. That is the shape, not a coincidence.
  **Evidence: one observation, LOCAL, at `61c2e19d` on 2026-11-27** (the integrated tree of
  `feature/tool-registration`, a merge commit — so read its diff against BOTH parents, not with a bare
  `git show --stat`, which on a merge lists only what differs from every parent and here printed a
  single file). `pnpm test` reported `Test Files 1 failed (220) / Tests 4 failed | 5285 passed |
  1 skipped`, and those four tests were the only failures. An **immediate re-run of the same command on
  the same commit** reported `Test Files 220 passed (220)` with **zero** occurrences of the string
  `guardprobe` in the output. **The re-run-green conclusion is sound rather than a coin flip, and the
  check is the one this file's header prescribes:** the union of `61c2e19d`'s two parent diffs is seven
  files — `src/components/settings/McpSection.tsx`, `McpSection.test.tsx`,
  `src-tauri/src/commands/settings.rs`, `scripts/file-size-baseline.txt`,
  `docs/features/mcp-known-gaps.md`, `CONTEXT.md`, and the new
  `docs/decisions/0123-user-supplied-tool-code-is-declined-the-registered-tool-surface-is-mcp-and-data.md`
  — and **none of them is reachable from palette code**: `git diff --name-only main...61c2e19d |
  grep -ciE 'palette|src/styles'` → `0`, and `git diff main...61c2e19d | grep -icE
  'palette|guardprobe'` → `0`, i.e. the word does not appear anywhere in the diff text. A diff with
  zero palette references cannot change what discovery enumerates. Per the file's own squash-orphan
  rule, prefer the run's own output over this SHA once the branch squash-merges: `61c2e19d` is an
  ancestor of `feature/tool-registration`'s HEAD today, but it will not survive the merge.
  **Re-run before investigating, and name the tell out loud so nobody re-derives the race.** Then do
  not treat this as a drive-by: unlike the load entries above there IS a real defect here, it is just
  not in the tests — closing it means the file-set change described above across the ten files, which
  is its own task with its own blast radius. And because this one is LOCAL, a green CI leg proves
  nothing about it: the load-sensitive entries above need a loaded runner to bite, this one only needs
  two files to be scheduled as near-simultaneous workers on your own machine.
