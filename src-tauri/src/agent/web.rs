//! The desktop half of the web subsystem: the headless renderer, plus the
//! re-export seam the moved halves need to stay reachable at their old paths.
//!
//! # Why this module exists and what lives in it
//!
//! T5/S2 moved the web subsystem into `fulcrum-core` — `cache`, `config`,
//! `extract`, `net`, `providers`, `tools`, plus the `RenderedPage` DTO and the
//! `RenderRequester` trait. `render.rs` did NOT move: it builds a
//! `tauri::WebviewWindow`, and the crate compiling without `tauri` is the master
//! roadmap's decoupling criterion.
//!
//! Rust resolves one `mod` declaration to ONE directory, so a crate boundary
//! running through the middle of a directory cannot be expressed as a SHARED
//! `web/` module tree: `crate::agent::web` (desktop) and `fulcrum_harness::web`
//! (crate) are two packages and can never be one module. This file is the
//! DESKTOP's `web` module. It declares the one submodule that stayed (`render`,
//! still a real file on the desktop disk) and re-exports the moved ones whose
//! MODULE alias a desktop path still spells — `cache, config, net, providers,
//! tools`. (`extract` is not among them: no desktop path names it at any
//! spelling, so its alias was pruned rather than kept as a second spelling of a
//! crate module nobody here reaches. The crate's own `web::extract` is untouched
//! by that — this is the desktop surface, not the crate's.)
//!
//! # Why the re-export half is not the forbidden shape
//!
//! The forbidden shape would be one that lets the CRATE reach the DESKTOP through
//! this path — a `crate::web::render` that the crate's own code could call, making
//! two packages look like one tree from the inside. That cannot happen here: the
//! crate's `web` module tree (`fulcrum/src/web/mod.rs`) declares six
//! submodules and NO `render`, and nothing in the crate names `web::render`
//! (measured at the move: zero references). The crate's view of `web` is complete
//! and desktop-free.
//!
//! What the re-export half does is the narrow, allowed direction, and it is the
//! SAME mechanism Step A.2 established in `agent/mod.rs` for S1's leaf modules:
//! it keeps the DESKTOP's existing paths compiling with zero edits. Two live
//! consumers require it and neither may be touched:
//!
//! * `commands/settings.rs` (OUTSIDE `agent/` — the acceptance criterion is zero
//!   edits to the 20 such files) names `crate::agent::web::config::{WebConfig,
//!   SEARCH_PROVIDERS}` (verified at `commands/settings.rs:221-222`, inside a live
//!   `#[tauri::command]` body) and `crate::agent::web::providers::registry::*`;
//! * `session/router.rs` names `crate::agent::web::render::{RenderRequest,
//!   render}`, which resolves to the local `pub mod render` above.
//!
//! `worker/core.rs` is NOT a consumer of this file: it is CRATE-OWNED since
//! T8/S8.2, its `impl crate::web::RenderRequester for IpcRenderRequester` lives in
//! `fulcrum/src/worker/core.rs`, and the trait + the `RenderedPage` DTO are
//! declared in the crate's `fulcrum_harness::web` module. The desktop reaches neither
//! name, so this file re-exports neither.
//!
//! One path prefix over two packages — which is what a re-export seam IS, and
//! which is why the two halves stay separately compilable: the crate builds with
//! no knowledge that this file exists (it is a rev-pinned git dependency now, and
//! its own tests run in its own repo, not from this checkout).
//!
//! # The direction of the one edge between the halves
//!
//! `render.rs` imports nothing from the crate. It owns `RenderRequest`/`RenderReply`
//! and `session/router.rs` drives them. The crate's `RenderRequester` trait —
//! declared in the crate's `web/mod.rs`, NOT in `render.rs`, which is why the
//! trait could move and the renderer could stay — used to be implemented by the
//! desktop's `worker/core.rs::IpcRenderRequester` (desktop → crate, the allowed
//! direction). T8/S8.2 moved `core.rs` into the crate, so that impl is now
//! crate-side inside `fulcrum_harness::worker::core` and the edge is intra-crate; the
//! renderer is still the only half that touches a `WebviewWindow`, and it still
//! names nothing in the crate's `web` tree, which is the reason the split works
//! either way.

pub mod render;

// The moved submodules whose MODULE alias a desktop path still spells, re-exported
// so every pre-existing `crate::agent::web::<module>::…` path in the desktop keeps
// resolving (the Step A.2 rule: re-export the MODULE, not just named symbols — a
// named-only block leaves every module-qualified consumer dangling).
pub use fulcrum_harness::web::{cache, config, net, providers, tools};
