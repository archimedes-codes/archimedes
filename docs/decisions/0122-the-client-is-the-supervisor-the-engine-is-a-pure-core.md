---
status: accepted
date: 2026-11-27
superseded-by:
---

# The Client is the Supervisor; the engine's need for `Settings` is one field

A card claimed the engine's ownership boundary was residue from a standalone `fulcrum-daemon` that was
never built. That is false — the daemon shipped (fulcrum `38a9986`, 8,402 lines), so ADR 0091's stated
justification for the boundary is realised, not hypothetical. But the settings half of that boundary is
24× wider than the crate's requirement: `fulcrum-harness` reads exactly **one** of `Settings`'s 24 fields
(`agent_overrides`, at `harness/launch.rs:115` and `:469`), and `packaged_settings` builds a synthetic
`Settings` from nothing but `HashMap<String, AgentOverrideFields>` — the crate's own code proves the
narrower input suffices. So we reaffirm **ADR 0091's disk boundary unchanged** (the crate reads no
`settings.json`; `load_settings` stays desktop; the two pins that encode it stay) and narrow the **type**
half: the crate's seam takes the map it actually reads, not the desktop's whole settings document, so a
desktop-only setting stops requiring a crate release. This narrows 0091; it does not supersede it.

**Why this and not the larger move.** The measured cost is 13 crates.io pin bumps and 14 hand-run,
irreversible `cargo publish`es in 18 days, and the desktop's own release ceremony on top. But ADR 0102's
host-tool inversion already removed the *tool* half of that friction (Keenable: 2 repos, 10 crate files,
1 publish → `d4b4995b`, which touches neither `Cargo.toml` nor `Cargo.lock`). What survives is the
*settings-shape* half, and it has an in-repo precedent executed twice: `DesktopConfig` (5 fields carved
from `Settings`'s 24, applied by builder) and `ProviderSource` (whose fix deleted the poller's
`config_dir` entirely, so *"the poller cannot ask for the file even by accident"*). The fix copies those,
and must not become a trait the crate does not call — `seams.rs:13-23` cancelled two tasks on exactly that
ground.

## Considered Options

- **Do nothing** — rejected: the FLOOR is measured, not argued. `StartEnv`, `DesktopConfig`, `FilePolicy`,
  `WebSettings`, `ProviderConfig`, `AgentOverrideFields`, `OidcConfig` and `ToolCtx` are load-bearing for
  the loop, the gate and the wire regardless of any daemon; `Settings`'s floor is one field. Only the
  latter is movable, and moving it is cheap.
- **Move the whole `Settings` type to the desktop** — viable, and the FLOOR says nothing forbids it, but
  it is a breaking public-API removal across 23 re-export statements / 222 alias-resolved references in 67
  files, and it forces the question this ADR deliberately does not answer (below).
- **Widen the crate with an extension point** (`ToolCtx` field, a `search_providers`-style seam) — already
  rejected twice: ADR 0121 (*"one irreversible release spent buying a transport that already ships"*), and
  ADR 0102's *"Registry as an appendix"* for a seam nothing populates.

## Not decided here

Two questions were found to be **prerequisites**, not consequences, and are deliberately left open:

1. **Whether a second Host may exist at all.** The app-as-Supervisor loses structurally on exactly two of
   eleven capabilities — surviving its own death (`lib.rs:376-382`: *"a Supervisor panic STILL kills the app
   (it IS the app)"*) and version skew (one binary = one engine version). The other nine are policy
   unwired, not architecture blocked. Nothing here forecloses either.
2. **Whether durable sessions are wanted.** `docs/roadmap/durable-sessions.md` (`status: approved`)
   requires them, and no shipped system in this space claims local sessions survive the GUI app being quit
   with the loop inside the GUI process. But no user signal for the feature exists outside the epic.

Both, plus the fact that the durable-sessions ADRs 0092/0093 exist only on an unmerged branch and collide
with two different ADRs of the same numbers on `main`, are recorded with evidence in
`docs/research/the-app-is-the-supervisor-the-engine-is-a-pure-core.md`.

## Consequences

- `CONTEXT.md` currently contradicts the durable-sessions spec: it makes the **Client** *"the
  **Supervisor**"* and lists **daemon** under `_Avoid_`, while the spec's central term **Host** is absent
  from the glossary. Whichever way the open questions resolve, one of those two documents is wrong today.
- The hardest remaining settings gate is **`WebSettings`, not `Settings`** — a new field there is
  source-BREAKING and forced a MINOR (fulcrum `477d3d4`). Narrowing `Settings` alone will not make a new
  Search provider's key free.
