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
//! `web/` module tree: `crate::agent::web` (desktop) and `fulcrum_core::web`
//! (crate) are two packages and can never be one module. This file is the
//! DESKTOP's `web` module. It declares the one submodule that stayed (`render`,
//! still a real file on the desktop disk) and re-exports the six that moved.
//!
//! # Why the re-export half is not the forbidden shape
//!
//! The forbidden shape would be one that lets the CRATE reach the DESKTOP through
//! this path — a `crate::web::render` that the crate's own code could call, making
//! two packages look like one tree from the inside. That cannot happen here: the
//! crate's `web` module tree (`crates/fulcrum-core/src/web/mod.rs`) declares six
//! submodules and NO `render`, and nothing in the crate names `web::render`
//! (measured at the move: zero references). The crate's view of `web` is complete
//! and desktop-free.
//!
//! What the re-export half does is the narrow, allowed direction, and it is the
//! SAME mechanism Step A.2 established in `agent/mod.rs` for S1's leaf modules:
//! it keeps the DESKTOP's existing paths compiling with zero edits. Two consumers
//! require it and neither may be touched:
//!
//! * `commands/settings.rs` (OUTSIDE `agent/` — the acceptance criterion is zero
//!   edits to the 20 such files) names `crate::agent::web::config::{WebConfig,
//!   SEARCH_PROVIDERS}` and `crate::agent::web::providers::registry::*`;
//! * `worker/core.rs` implements the crate's `crate::agent::web::RenderRequester`
//!   and builds `crate::agent::web::RenderedPage`.
//!
//! And `session/router.rs` keeps naming `crate::agent::web::render::{RenderRequest,
//! render}`, which resolves to the local `pub mod render` above. One path prefix,
//! two packages underneath — which is what a re-export seam IS, and which is why
//! the two halves stay separately compilable: `cargo test -p fulcrum-core` builds
//! the crate with no knowledge that this file exists.
//!
//! # The direction of the one edge between the halves
//!
//! `render.rs` imports nothing from the crate. It owns `RenderRequest`/`RenderReply`
//! and `session/router.rs` drives them. The crate's `RenderRequester` trait —
//! declared in the crate's `web/mod.rs`, NOT in `render.rs`, which is why the
//! trait could move and the renderer could stay — is implemented by the desktop's
//! `worker/core.rs::IpcRenderRequester`. Desktop → crate: the allowed direction.

pub mod render;

// The six submodules that moved, re-exported so every pre-existing
// `crate::agent::web::<module>::…` path in the desktop keeps resolving (the
// Step A.2 rule: re-export the MODULE, not just named symbols — a named-only
// block leaves every module-qualified consumer dangling).
pub use fulcrum_core::web::{cache, config, extract, net, providers, tools};

// The two names the desktop reaches at the `web` ROOT rather than through a
// submodule: the trait the Worker implements and the DTO it returns.
pub use fulcrum_core::web::{RenderRequester, RenderedPage};
