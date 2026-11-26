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

use serde_json::Value;

use crate::agent::tools::ToolResult;
use crate::storage::{AdvanceAdvice, Db, HostToolError};

use super::{opt_str, spawn_host_call, to_details};

/// `mark_done` — this Session claims its work is done and a person should look at it.
///
/// ONE optional parameter — `outcome`, the name of the transition to take — and the
/// interface risk is still entirely in who is allowed to make the claim: the two
/// refusals below, the one answer that reports writing nothing, and the rule that
/// `params` is read for `outcome` and for no id of any kind.
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
/// # The instruction that rides the answer
///
/// `details.advanceAdvice`, and it is the reason this verb takes `params` at all. Rust
/// decides and the frontend acts — see [`crate::storage::db::advise`]'s header for why
/// the decision cannot live in TypeScript and why the ACT cannot be done here — so the
/// answer has to carry the instruction or the decision dies in a tool result nobody
/// re-reads.
///
/// The mark ITSELF still reaches the UI through the BOARD read (`TaskCardView.ready`),
/// which is the channel that survives a restart; a tool-result payload is not that, and
/// `advanceAdvice` is not a second copy of the flag. It is the one fact a restart cannot
/// reconstruct — that THIS turn's claim resolved to THIS destination — and the claim path
/// consumes it once, from the tool result it is sitting in.
///
/// Adding the key costs four coordinated edits in
/// `src/lib/toolDetailsRegistry.test.ts` (the frozen producer tuple, its length pin, the
/// fixture group, and the annotated reason in the unread-key table). Two of the four
/// fail the BUILD via that file's `AssertEqual` seal and its exhaustive
/// `Record<UnreadProducerKey, string>`; the other two — the length pin and the fixture
/// group — are caught by `vitest run` on that file (guard 3's runtime read, and guard
/// 4's fixture coverage), so the full bar has to RUN that file, which is why the plan
/// names it explicitly rather than trusting `vitest run src/components` to reach it.
/// Either way a skipped edit is loud, and that is the point of the seal — the four are
/// named in the commit that lands them.
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
    params: &Value,
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

    // THE ONE PARAMETER, and the rule that keeps it the only one. `params` is read for
    // `outcome` and NOTHING else: no `session_id`, no `task_id`, no `space_path`. A
    // session id in `params` is a session id the model chose, and cards link to the
    // launching Session, so honouring one would let this Session mark ANOTHER's card —
    // the un-spoofability pin in `super::tests::verbs` is what reddens if this line ever
    // grows a second `opt_str`.
    // Owned, because the closure below runs on the blocking pool and is `'static`.
    let outcome: Option<String> = opt_str(params, "outcome")?.map(str::to_string);

    // Two bindings, because the id has to survive the closure that consumes it: the
    // `false` sentence below NAMES the id, and a refusal that does not say what it
    // rejected is a refusal the model cannot act on (the rule `missing` states for a
    // parameter and `BoardError`'s `Display` states for a card id).
    let session_id = session_id.to_string();
    let origin_session_id = session_id.clone();
    let advice_session_id = session_id.clone();
    // A second binding for the same reason the id has two: the closure consumes one and
    // the sentence below names what the model actually asked for.
    let named_outcome = outcome.clone();
    let db = db.clone();

    // ONE blocking call for the write AND the decision. They are one call because the
    // decision reads `sessions.ready` — the flag this call writes — so deciding before
    // the write would answer `unclaimed` about the very claim it is answering for, and
    // deciding in a second call would put a lock between the two that a concurrent turn
    // start can clear the flag across.
    //
    // The tuple is the shape `spawn_host_call` needs (one `Send + 'static` value); the
    // `BoardError` half converts through the `From` impl this helper is generic over,
    // which is exactly the reason that genericity exists.
    let (claimed, advice) = spawn_host_call::<_, HostToolError, _>("mark_done", move || {
        let claimed = Db::set_session_ready(&db, &origin_session_id, Some(true))?;
        // `None` for the cost delta, always, on this door. The turn is still running
        // and `sessions.cost_usd` is a RUNNING TOTAL, so the delta for THIS turn does not
        // exist yet — the frontend computes it from a before-turn snapshot at settle.
        // `None` is NOT "skip the ceiling": it means the fold adds nothing and the
        // comparison still runs against whatever earlier settles banked on the open run,
        // so a chain that has already blown its ceiling stops here rather than launching
        // one more link. The settle fallback is where a real figure arrives.
        let advice = db.workflow_advance_advice(&advice_session_id, outcome.as_deref(), None)?;
        Ok((claimed, advice))
    })
    .await?;

    Ok(ToolResult::ok_text(
        sentence_for(&session_id, claimed, named_outcome.as_deref(), &advice),
        Some(to_details("advanceAdvice", &advice)?),
    ))
}

/// The model-facing sentence, built from what the DECIDER returned and never from a
/// number this file holds.
///
/// `max_steps` and `ceiling_usd` are interpolated from the advice because the effective
/// bounds are Rust-only on purpose — a literal `20` here would be a policy number
/// smuggled into a second file, and a Space that configured `3` would be told it hit 20.
/// The same reason `AdvanceVerdict` carries those fields at all: a caller given only
/// `advance: false` can say a chain stopped and nothing about why.
///
/// Every branch says what HAPPENED to the card, because that is the fact the model
/// cannot get from anywhere else — the flag it just set it can see in its own tool
/// result, and the column it is in it can see in its prompt. What it cannot see is
/// whether the card moved, and a model that does not know has been measured to try the
/// move again through `move_task`, which the forward gate then refuses.
fn sentence_for(
    session_id: &str,
    claimed: bool,
    outcome: Option<&str>,
    advice: &AdvanceAdvice,
) -> String {
    // The one arm where the write itself failed, and the reason it is not an error: the
    // caller cannot retry its way into a row that does not exist, and a failed tool
    // result invites exactly that. It still comes FIRST, because an `Ok` that says
    // "marked" about a row it did not touch is the confident lie this verb exists to
    // remove — and an advance decided for a phantom Session would be its twin.
    if !claimed {
        return format!(
            "mark_done wrote nothing: this frame's origin session id `{session_id}` \
             matches no Session row, so nothing was flagged and nothing advanced"
        );
    }
    if advice.advance {
        let label = advice
            .destination
            .as_ref()
            .map(|d| format!("`{}`", d.slug))
            .unwrap_or_else(|| "the next column".to_string());
        return if advice.reason == "advanced_unnamed_edge" {
            format!(
                "this Session is marked done and its card advanced to {label} — this \
                 column has no transition named `{}`, so the first one was taken",
                outcome.unwrap_or("")
            )
        } else {
            format!("this Session is marked done and its card advanced to {label}")
        };
    }
    // The refusals, each naming what the model can do about it. The bound arms quote the
    // numbers AS THE ADVICE RETURNED THEM.
    match advice.reason.as_str() {
        "max_steps" => format!(
            "this Session is marked done, but the chain is at its {}-step bound, so the \
             card stayed put",
            advice.max_steps.unwrap_or(0)
        ),
        "cost_ceiling" => match advice.ceiling_usd {
            Some(ceiling) => format!(
                "this Session is marked done, but the chain has reached its ${ceiling:.2} \
                 ceiling, so the card stayed put"
            ),
            // No figure to quote. `None` means "no ceiling is configured", and it must
            // NOT be rendered as `$0.00` — that would be ADR 0082's phantom zero, in a
            // sentence, on the one number a person might act on.
            None => "this Session is marked done, but the chain has reached its cost \
                     ceiling, so the card stayed put"
                .to_string(),
        },
        "not_automatic" => "this Session is marked done and flagged for review; this \
                            column is not automatic, so the card stayed put and a person \
                            moves it"
            .to_string(),
        "already_advanced" => "this Session is marked done; this handoff has already \
                               launched, so nothing moved again"
            .to_string(),
        "unclaimed" => "this Session is marked done; the card did not advance".to_string(),
        "no_next_stage" => "this Session is marked done and flagged for review; this \
                            column leads nowhere, so the card stayed put"
            .to_string(),
        // No card to advance. The flag still landed, and that is the whole truth.
        _ => "this Session is marked done — a person should look at it, though this \
              Session is not linked to a card, so nothing moved on the board"
            .to_string(),
    }
}
