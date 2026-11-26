//! The ONE host verb whose SUBJECT IS THE CALLING SESSION.
//!
//! The seven board verbs in [`super::board`] take their subject from `params` — a
//! card is not the caller, so a card id has to be named — and they never look at the
//! frame's identity. This verb is the opposite case: its subject IS the caller, so it
//! takes that subject from the frame ([`super::run`]'s `origin`) and its parameter
//! object is deliberately EMPTY. There is nothing for the model to get wrong, and no
//! session id for it to name, which is what makes the claim un-spoofable: a Session
//! can only mark ITSELF done.

use std::sync::Arc;

use crate::agent::tools::ToolResult;
use crate::storage::{Db, HostToolError};

use super::spawn_host_call;

/// `mark_done` — this Session claims its work is done and a person should look at it.
///
/// No `params` at all (the spec advertises `{"properties":{},"required":[]}`), and the
/// interface risk is entirely in who is allowed to make the claim — the two refusals
/// below and the one answer that reports writing nothing.
///
/// # Why the subject is the frame's origin id and never a value in `params`
///
/// `params` is untrusted model JSON; `origin` is the `session_id` the Worker put on
/// its own request frame. A verb that let the caller NAME the session it is finishing
/// would let one Session mark ANOTHER done — and cards link to the launching Session,
/// so the mark would appear on a card the caller has no business claiming. This is the
/// same rule `task_reply_target`'s own doc states for the reply address in
/// `agent/session/router.rs`: a delivery id is not a reply address, and here the
/// generalisation is that a delivery id is not a SUBJECT either. So a frame with no
/// origin id is REFUSED, never defaulted to the delivery id.
///
/// # Why a child is refused rather than quietly accepted
///
/// A child's frame carries the CHILD's own id, and a child's claim would render
/// nowhere: cards link to the launching Session, and a child's `todos_update` never
/// persists either (`agent/session/router.rs:46-52` is the same fact about the other
/// child-shaped write). A Subagent's completion is not a card's fact — the card's
/// handoff belongs to the Session that launched the work. So this REFUSES and names the
/// reason. It never no-ops: a silent success here is precisely the defect this verb
/// exists to remove, and `Ok` is the one answer a supporter cannot distinguish from a
/// mark that landed.
///
/// # What the answer does NOT carry
///
/// `details: None`, and that is a decision and not an omission.
/// `src/lib/toolDetailsRegistry.test.ts` freezes the producer-key tuple, so a NEW
/// `details` key costs four coordinated edits in that file and `pnpm build` fails via
/// its `AssertEqual` seal if one step is skipped. `super::board::get_artifact` is the
/// in-tree precedent for a verb that answers with a sentence alone. The mark reaches
/// the UI through the BOARD read (`TaskCardView.ready`, ADR 0113's follow-up), which
/// is the channel that survives a restart — a tool-result payload would not be.
///
/// # The row that is not there
///
/// `Db::set_session_ready` is an id-only `UPDATE` and answers `false` for an id that
/// matches no row. That is NOT folded into a success sentence here: the verb answers
/// with its own sentence naming the id, because an `Ok` that says "marked" about a row
/// it did not touch is the confident lie this card exists to remove. It is still not an
/// error, because the caller cannot retry its way to a row that does not exist and a
/// failed tool result invites exactly that. Task 4's turn-start clear is the other half
/// of the flag's life; neither this verb nor that one decides liveness.
pub(super) async fn mark_done(
    db: &Arc<Db>,
    origin: Option<&str>,
    is_subagent: bool,
) -> Result<ToolResult, HostToolError> {
    if is_subagent {
        return Err(HostToolError::Invalid {
            message: "mark_done is not available to a Subagent: a Subagent's completion \
                      is not a card's fact. Finish in the Session that launched the work \
                      and mark that one done."
                .to_string(),
        });
    }
    let Some(session_id) = origin else {
        return Err(HostToolError::Invalid {
            message: "mark_done needs the calling Session's id from the frame, and this \
                      frame carried none — the delivery id is not a substitute for it. \
                      Nothing was written."
                .to_string(),
        });
    };

    // Two bindings, because the id has to survive the closure that consumes it: the
    // `false` sentence below NAMES the id, and a refusal that does not say what it
    // rejected is a refusal the model cannot act on (the rule `missing` states for a
    // parameter and `BoardError`'s `Display` states for a card id).
    let session_id = session_id.to_string();
    let origin_session_id = session_id.clone();
    let db = db.clone();
    let claimed = spawn_host_call("mark_done", move || {
        Db::set_session_ready(&db, &origin_session_id, Some(true))
    })
    .await?;

    // Two sentences, because `set_session_ready` answers `false` for an id that
    // matches no row and an `Ok` that says "marked" about a row it did not touch is
    // the confident lie this whole card is about. Both carry `details: None`.
    let sentence = if claimed {
        "this Session is marked done — a person should look at it".to_string()
    } else {
        format!(
            "mark_done wrote nothing: this frame's origin session id `{session_id}` \
             matches no Session row"
        )
    };
    Ok(ToolResult::ok_text(sentence, None))
}
