//! The **subagent parent link**: the ONE place the DESKTOP writes
//! `sessions.parent_session_id`.
//!
//! Named to mirror the storage half of the same subject: the VERB lives in
//! `storage/db/parent_link.rs` (T1's file), the POLICY lives here. One subject,
//! one file per layer — ADR 0113's naming rule applied twice. The symmetry is
//! intentional; do not "unify" the two files.
//!
//! A child's row is created INSIDE the pinned crate (`persist.rs:279`'s
//! `ensure_session_row`), and `SessionInfo` is the crate's own type — so the
//! desktop cannot pass the parent through the row's constructor and fills the
//! column in afterwards, from the one funnel that holds both ids: `route_event`.
//!
//! NULL means "parent never known" and stays NULL rather than guessing. No
//! `DEFAULT` on the column for the same reason `cost_usd` has none: a default
//! invents a parent (`db/mod.rs`'s `cost_usd` gate, the phantom-`$0.00` argument
//! at `:684-697`). And a frame the GUARD rejects is not a lost link waiting to be
//! repaired: the guard only fires once the crate's `drives` entry is gone for
//! good, so every frame that could name a parent already did.
//!
//! WHY THE DELIVERY ID IS THE PARENT — ADR 0117. `docs/decisions/0117-…` decided
//! that *"a frame's delivery address identifies the SCOPE IT RENDERS IN, and is
//! never the address of the process that must be answered"*, and grounds it in
//! the pump re-keying a child's frames to its parent's id
//! (`worker/manager/pump.rs:91-102`). This module reads that address for the one
//! thing it CAN name — the scope, which for a child is the parent's session —
//! and refuses it the moment the scope collapses onto the child's own id, which
//! is 0117's own rule against ever falling back to a delivery id. Note this is
//! a DIFFERENT seam from the retention ADR (0118): 0117 is about where an answer
//! goes, 0118 about which session spawned which.

use crate::agent::worker::protocol::StoreFrame;

use super::SessionManager;

impl SessionManager {
    /// The CHILD id a `StoreFrame` belongs to — the frame's OWN `session_id`,
    /// which is the same extraction `persist.rs:125-130`'s `apply` makes and for
    /// the same reason: the outer delivery id is the PARENT's (`pump.rs:91-101`,
    /// the arm; ADR 0117 cites it as `:91-102` because it includes the
    /// `on_event(&delivery_id, …)` hand-off at `:102`) while the row belongs to
    /// the CHILD.
    ///
    /// The match is EXHAUSTIVE over the crate's four variants, so a fifth
    /// `StoreFrame` variant is an `E0004` HERE and in the crate's `apply` at the
    /// same time — a silent drop of a new variant is a compile error, not a
    /// `None`.
    pub(super) fn frame_child_id(frame: &StoreFrame) -> &str {
        match frame {
            StoreFrame::Insert { session_id, .. }
            | StoreFrame::Replace { session_id, .. }
            | StoreFrame::Display { session_id, .. }
            | StoreFrame::ContextUsage { session_id, .. } => session_id,
        }
    }

    /// Stamp `delivery_id` as `child_id`'s parent, if — and only if — it can be
    /// shown to be one.
    ///
    /// `sessions.parent_session_id` ONLY, via
    /// [`Db::set_session_parent_if_unset`](crate::storage::Db::set_session_parent_if_unset)
    /// (T1's verb, in `storage/db/parent_link.rs`): no transcript table, no
    /// `sessions` row created (the crate's `ensure_session_row` owns that),
    /// nothing read back.
    ///
    /// A failure is LOGGED, not returned — the same shape `flush_batched` uses
    /// (`mod.rs:1196-1201`): every call site is inside frame handling, which has
    /// one `Result` to hand back and it belongs to the frame. A lost link costs
    /// attribution, not data. This module neither catches nor recovers anything:
    /// the verb's poisoned-mutex decision is the VERB's and is documented with
    /// the verb, in `storage/db/parent_link.rs`.
    pub(super) fn link_subagent_parent(
        &self,
        delivery_id: &str,
        is_subagent: bool,
        child_id: &str,
    ) {
        if !is_subagent {
            return;
        }
        // THE GUARD, and it is the whole design. `pump.rs`'s `delivery_id` falls
        // back to the CHILD's OWN id when the `drives` lookup misses
        // (`pump.rs:91-101`, the `unwrap_or_else(|| session_id.clone())` at
        // `:98`), and it misses only AFTER the teardown REMOVED the entry: the
        // entry is inserted ONCE, at dispatch, before the pump is even subscribed
        // (`subagent_flow.rs:965-980`; `:998-1000` "subscribed BEFORE
        // `send_start`"), and removed at `:1913-1914` (reap FIRST at `:1907`) — or
        // at `:1057-1058` on the preflight-failure path. It is NEVER
        // re-inserted: one `drives.insert` and two `drives.remove` STATEMENTS in
        // that whole file (`:966`, `:1058`, `:1914` — count them with an ANCHORED
        // grep, `grep -nE '^\s*drives\.(insert|remove)'`, because the loose
        // unanchored one also matches two comment lines that only NAME the
        // removal).
        //
        // So a frame that arrives with `session_id == child_id` is a straggler
        // that outlived its own drive, and every frame that arrived WHILE the
        // drive existed already resolved to the parent and already wrote the
        // link. SKIP: the honest answer is the NULL that is already there. More
        // stragglers may still arrive behind this one — the pump consumes a
        // `tokio::sync::broadcast` ring (`pump.rs:51`), so several frames can be
        // queued when the entry goes — but NONE of them can resolve, because the
        // `drives` lookup misses for all of them from here on. That is why the
        // skip costs nothing and why there is nothing to repair afterwards.
        // Writing would attribute a child to itself.
        //
        // ADR 0117 is the merged, independent statement of WHY the delivery id
        // may be read for a parent at all and why it may not be read here:
        // "a frame's delivery address identifies the SCOPE IT RENDERS IN, and is
        // never the address of the process that must be answered" — and the
        // corollary that you NEVER fall back to a delivery address when the real
        // address is absent. Equal ids means the address has collapsed onto the
        // child: it names no scope that is not the child, so it names no parent.
        if child_id == delivery_id {
            return;
        }
        let Some(db) = self.driver.db.as_deref() else {
            return;
        };
        // No lock is held here: `p.apply` released `Db`'s mutex inside its own
        // verbs before returning, so this is a separate critical section and
        // cannot deadlock against the persister.
        if let Err(e) = db.set_session_parent_if_unset(child_id, delivery_id) {
            crate::agent::debuglog::log(&format!(
                "subagent parent link ({child_id} <- {delivery_id}) FAILED: {e}"
            ));
        }
    }
}
