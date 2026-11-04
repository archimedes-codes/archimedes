---
status: accepted
date: 2026-11-04
---

# fulcrum-core's boundary: seams over moves, with the desktop owning the disk

T5 lifted the agent harness out of the desktop binary into `crates/fulcrum-core` — the crate
`fulcrum-daemon` (T9) will link it, and a daemon has no `tauri`, no `settings.json` and no
`storage::Db`. The crate therefore may not name a desktop module, in either direction of
convenience. This ADR records how the boundary was drawn, because the interesting part is not
what moved: it is the four kinds of thing that could not, and what each became instead.

**The rule. A module moves only if the crate needs it; a thing the crate needs but cannot hold
becomes a seam; a thing that holds a desktop type splits in two.** A plan's file list is an
estimate — the closure is what compiles. Three claims in T5's own plan turned out to be wrong
against the tree, and each was caught by measuring before implementing rather than by the
compiler afterwards (see *Corrections* below).

## What the crate may not reach, and what each became

Four desktop surfaces are unreachable from the crate. Each got the same treatment: the *shape*
crosses, the *substance* stays.

1. **The store (`storage::Db`).** `DbError` wraps `rusqlite::Error`, so it cannot cross. The
   crate declares `StoreError { Io, Json }` (`crates/fulcrum-core/src/seams.rs:90`) and the
   desktop maps `DbError::Sqlite(_) → StoreError::Io` at the boundary. `trait Store` and
   `NoopStore` live in the crate (`crates/fulcrum-core/src/harness/store.rs:61,101`);
   `SessionStore(Arc<Db>)` and its `impl Store` stay desktop
   (`src-tauri/src/agent/harness/store.rs:76,78`) and re-export the crate types, so every
   pre-existing desktop spelling still resolves. `worker/store.rs`'s `impl Store for IpcStore`
   is desktop for the same reason and will move with the worker in T8.

2. **Settings on disk.** `Settings` and `FontSettings` moved into the crate as plain DTOs
   (`crates/fulcrum-core/src/config_types.rs:265,216`) — all sixteen fields are `std`/`serde` or
   already-crate types. **`load_settings` did not move, and no crate file may read
   `settings.json`.** The type lives in both places; the file lives in one. Changes flow one way,
   by push: the desktop reads disk, then hands the harness a `DesktopConfig`
   (`crates/fulcrum-core/src/worker_types.rs:242-246` — `file_policy`, `web`, `mcp_servers`,
   `agent_overrides`, `providers`) through `AgentLoop::set_desktop_config`
   (`src-tauri/src/agent/worker/core.rs:363`). **The desktop drives; the crate never pulls.**
   This is what lets `harness/launch.rs:108,431` take a `Settings` in production without the crate
   owning a config file.

3. **Opening a browser (`open.rs`, which is `tauri`).** `trait OpenRequester` is held by the MCP
   manager and injected at construction (`crates/fulcrum-core/src/mcp/mod.rs`). S3 made one
   mistake worth keeping as a lesson: it wired `crate::open::desktop_open_requester()` *inside*
   `AgentLoop::new`, which compiled only because `harness` was still desktop — the right seam, on
   the wrong side of the boundary. S5a corrected it: `AgentLoop::new` takes the
   `Arc<dyn OpenRequester>` (`crates/fulcrum-core/src/harness/loop.rs:699`), stores it, and
   `set_desktop_config` re-uses the stored one rather than building a default.

4. **Sessions and subagent dispatch.** `trait FulcrumPersistence` and `trait Dispatcher`
   (`seams.rs`) are the surfaces; `agent/persist.rs` holds an `Arc<dyn FulcrumPersistence>`, not an
   `Arc<Db>`, and `agent/subagent.rs` dispatches through `Dispatcher`, not `WorkerManager`. Both
   implementations stay desktop through T8.

## Re-export, not duplicate

Desktop paths must keep resolving or the move is a rewrite of 193 call sites. Every moved module
is re-exported at its old path — the module *and* its named symbols (`src-tauri/src/agent/mod.rs`,
`harness/mod.rs`). Where a module only partly moves, the desktop keeps a real file of that name
holding the unmovable half and re-exporting the movable one: `harness/trust.rs` keeps
`SqliteTrustSource(Arc<Db>)` and re-exports `TrustSource` + `StaticTrustSource`;
`agent/provider_auth/mod.rs` keeps everything except `headers`, which is re-exported from the
crate as `provider_headers`. **`pub(crate)` does not survive a package boundary** — items the
staying desktop still names were raised to `pub` (nine in S1, one in S5a).

## Type closure is what actually sets the scope

`StartEnv` embeds `Model` and `ModelCatalog`, so the wire types could not move without the catalog
and provider types — modules the plan had filed under a later sub-step. `LaunchConfig` had to be
extracted from `subagent.rs` in S3 because `interactive` needed it and `subagent.rs` could not move
until S5. `Settings` needed `FontSettings`. **A sub-step's file list is a guess about the closure;
the closure is the constraint.**

## The one behaviour change, named

`DbError::Sqlite(_) → StoreError::Io` lengthens an error string. A SQLite failure reaching
`session/mod.rs:1473`'s `.map_err(|e| SessionError::Io(e.to_string()))` now reads
`"io error: sqlite error: …"` where it read `"sqlite error: …"`. Error paths only, and only a
corrupt or unreadable database. `tests` pin both halves — the string as it was and as it now is
(`src-tauri/src/agent/harness/store.rs:347`) — so the deviation is a fact on the record rather
than a rumour. The desktop's own `DbError` is unchanged for every desktop-only caller.

## The boundary is tested, and the test is tested

`crates/fulcrum-core/src/boundary_pins.rs` (`#[cfg(test)]`, so the module that names the forbidden
identifiers does not ship into the binary) asserts the crate reads no desktop settings file, names
no `tauri`/`rusqlite`/`archimedes_lib`, declares none of them as a dependency, and — the S5b
addition — that **no `crate::config::`, `crate::storage::` or `crate::open::` path survives in the
crate at all**, by checking every `crate::X::` against the modules `lib.rs` actually declares.

**An identifier list is not a boundary proof.** The original six needles matched
`load_settings`, `settings.json`, `rusqlite` and friends; `crate::config::Settings` matched none of
them and crossed unnoticed. Two integrity tests exist because of how easily these scans go
vacuous-green: `the_needles_are_the_identifiers_they_stand_for` and
`the_path_needles_are_the_paths_they_stand_for` assert each assembled needle equals the identifier
built from its raw characters and that the scan fires on planted code;
`path_prose_is_stripped_but_code_is_not` pins that stripping comments does not strip code. Measured
bugs they caught: a `needle()` that joined its parts with a separator, so **every** needle matched
nothing and all three scans passed a planted `settings.json` read; and a boundary census that read
`use foo::{A, B}` as one hit attributed to `A`, reporting a clean boundary while `Settings` sat in
the second position. **Expand brace groups, and read the line, not the count.**

## Corrections, kept because they are the useful part

- The plan filed all of `provider_auth` under the crate. The crate needs exactly one item from it
  (`headers::expand_map`), so `budget`/`refresh`/`cli_sso`/`gcloud`/`key_helper`/`litellm_oauth`/
  `oidc`/`store` stayed desktop — and two seams already specified for them (a refresh trait, a
  `ProviderSource`) were cancelled unread. **Enumerate the crossing edges, then write the seams.**
- `permission.rs` was in S2's scope, never moved, and **nothing noticed for three sub-steps**,
  because the crate never referenced it. A missed move that no consumer needs is invisible to every
  gate; only "what does the *next* move still reach?" finds it.
- Two `harness` structures were called "pure" and are not: `trait Store` (all six methods return
  `Result<_, DbError>`) and `trust.rs` (holds `Arc<Db>`). Both would have failed at compile time
  after the move.
