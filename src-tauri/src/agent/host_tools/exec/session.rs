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
use crate::storage::{
    AdvanceAdvice, Db, HostToolError, REASON_ADVANCED_UNNAMED_EDGE, REASON_ALREADY_ADVANCED,
    REASON_COST_CEILING, REASON_MAX_STEPS, REASON_NOT_AUTOMATIC, REASON_NO_NEXT_STAGE,
    REASON_UNCLAIMED, REASON_UNLINKED,
};

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
        // THE CLAIM AND ITS EDGE NAME, in ONE write. `set_session_ready` updates both
        // columns in one statement precisely because they are one fact — a claim, and
        // the transition it claims — and a name persisted in a second statement could
        // be left behind by a turn-start clear that lands between the two, or could
        // survive a claim that was never written. This closure already holds the one
        // lock the claim takes, so persisting here costs no second acquisition; the
        // alternative (a separate verb) would put a lock between a claim and its name,
        // which is the same window this closure exists to close.
        //
        // The settle door reads this column back inside `decide`, and that is the whole
        // reason it is stored rather than passed: the settle has no name to report, so
        // without a persisted name it resolves the head edge and the model's choice is
        // silently discarded at the second door.
        let claimed =
            Db::set_session_ready(&db, &origin_session_id, Some(true), outcome.as_deref())?;
        // `None` for the cost delta, always, on this door. The turn is still running
        // and `sessions.cost_usd` is a RUNNING TOTAL, so the delta for THIS turn does not
        // exist yet — the frontend computes it from a before-turn snapshot at settle.
        // `None` is NOT "skip the ceiling": it means the fold adds nothing and the
        // comparison still runs against whatever earlier settles banked on the open run,
        // so a chain that has already blown its ceiling stops here rather than launching
        // one more link. The settle fallback is where a real figure arrives.
        //
        // `outcome` is passed explicitly AND read back from the row a moment later, and
        // the two are the same value by construction — the statement above just wrote
        // it. Passing it keeps this door honest about what the model typed even if the
        // row write matched nothing (`claimed == false`), and `decide` prefers a name it
        // was handed over one it read.
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
        // Two reasons arrive with `advance: true`, and only the second earns the hedge.
        // The catch-all is deliberate: a reason this file has never seen on a verdict
        // that says the card MOVED still gets the true sentence — it moved to `label` —
        // so this arm needs neither a hedge nor an apology. In practice the reasons that
        // land here are `advanced_unnamed_edge` above and `REASON_ADVANCED` here, and
        // the refusal table below is where an unknown reason must not be guessed at.
        return match advice.reason.as_str() {
            REASON_ADVANCED_UNNAMED_EDGE => format!(
                "this Session is marked done and its card advanced to {label} — this \
                 column has no transition named `{}`, so the first one was taken",
                outcome.unwrap_or("")
            ),
            _ => format!("this Session is marked done and its card advanced to {label}"),
        };
    }
    // The refusals, each naming what the model can do about it. The bound arms quote the
    // numbers AS THE ADVICE RETURNED THEM.
    //
    // EVERY arm names a `REASON_*` CONST and not a literal, and that is the binding
    // this table was missing: the spellings are `advise`'s, and a `match` on copied
    // strings cannot see the list change, so an eighth refusal would compile clean and
    // fall to the arm below. The consts arrive through `storage/mod.rs` — see the
    // `pub(crate) use` there for why two hops are needed.
    match advice.reason.as_str() {
        REASON_MAX_STEPS => match advice.max_steps {
            Some(steps) => format!(
                "this Session is marked done, but the chain is at its {steps}-step bound, \
                 so the card stayed put"
            ),
            // The arm the ceiling has had all along and this one did not: `None` means
            // no number was returned, so no number is quoted. The old
            // `unwrap_or(0)` rendered a phantom "0-step bound" — a bound nobody
            // configured, on the one figure a person would act on. Runtime-dead today
            // (every arm but `unlinked` carries the effective number) and still wrong.
            None => "this Session is marked done, but the chain is at its step bound, so \
                     the card stayed put"
                .to_string(),
        },
        REASON_COST_CEILING => match advice.ceiling_usd {
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
        REASON_NOT_AUTOMATIC => "this Session is marked done and flagged for review; this \
                                 column is not automatic, so the card stayed put and a \
                                 person moves it"
            .to_string(),
        REASON_ALREADY_ADVANCED => "this Session is marked done; this handoff has already \
                                    launched, so nothing moved again"
            .to_string(),
        REASON_UNCLAIMED => "this Session is marked done; the card did not advance".to_string(),
        REASON_NO_NEXT_STAGE => "this Session is marked done and flagged for review; this \
                                 column leads nowhere, so the card stayed put"
            .to_string(),
        // No card to advance. The flag still landed, and that is the whole truth. This
        // claim is `unlinked`'s ALONE — it is the only arm whose Session provably owns
        // no card — so it now has its own arm and the catch-all below may not make it.
        REASON_UNLINKED => "this Session is marked done — a person should look at it, \
                            though this Session is not linked to a card, so nothing moved \
                            on the board"
            .to_string(),
        // A reason this table does not know. NEUTRAL, and it quotes the reason it was
        // given rather than asserting a cause: the sentence used to be `unlinked`'s, so
        // every future refusal was silently told it had no card — a claim this arm has
        // no evidence for and that may well be false. Naming the unknown reason keeps
        // the sentence true and makes the gap visible to whoever reads the transcript.
        _ => format!(
            "this Session is marked done; the card did not advance (`{}`)",
            advice.reason
        ),
    }
}

#[cfg(test)]
mod tests {
    //! The sentence table, pinned at the one door that renders it.
    //!
    //! This region is INLINE rather than a child of `host_tools/tests/` for a
    //! mechanical reason: [`sentence_for`] is private and every field it reads
    //! arrives on the advice, so a test that goes through `run` cannot hand it a
    //! `reason` the decider does not currently emit — which is exactly the input
    //! the unbound-table pin below needs. ADR 0113 permits this (the mirror binds
    //! the naming of a `tests/` directory that exists; `agent/` holds inline
    //! regions beside its children).

    use super::*;

    /// A refusal-shaped advice carrying `reason` and nothing else interesting —
    /// every other field holds what a refusal carries anyway, so the table under
    /// test is the only variable in each assertion below.
    fn refused(reason: &str) -> AdvanceAdvice {
        AdvanceAdvice {
            advance: false,
            stop: None,
            destination: None,
            reason: reason.to_string(),
            max_steps: Some(20),
            ceiling_usd: Some(10.0),
            task_id: Some("tsk_under_test".to_string()),
            space_path: Some("/exec/session".to_string()),
            already_launched: false,
        }
    }

    /// THE FINDING THIS REGION EXISTS FOR: the table was keyed on string literals
    /// duplicated from `advise.rs`, so an eighth refusal would compile clean and be
    /// told the `unlinked` sentence — "not linked to a card" about a card that may
    /// well exist. The catch-all must be NEUTRAL and must name the reason it was
    /// given, so a new refusal reads as itself and not as a lie about the card.
    #[test]
    fn a_reason_the_table_does_not_know_renders_neutral_and_not_the_unlinked_sentence() {
        let text = sentence_for(
            "sess-1",
            true,
            None,
            &refused("a_refusal_nobody_has_written_yet"),
        );

        assert_eq!(
            text,
            "this Session is marked done; the card did not advance \
             (`a_refusal_nobody_has_written_yet`)",
            "an unknown reason gets the neutral sentence with the reason quoted"
        );
        assert!(
            !text.contains("not linked to a card"),
            "and it is NOT the `unlinked` sentence — that claim is arm 0's alone, \
             and asserting it about a card that exists is the confident lie this \
             guard refuses; got {text}"
        );
        assert!(
            !text.contains("leads nowhere"),
            "nor is it any other refusal's sentence; got {text}"
        );
    }

    /// `unlinked` keeps its own sentence now that the catch-all is neutral, and the
    /// only way to keep it is to name it — which is why the arms read the consts.
    #[test]
    fn the_unlinked_reason_still_gets_the_cardless_sentence() {
        let text = sentence_for("sess-1", true, None, &refused(REASON_UNLINKED));
        assert_eq!(
            text,
            "this Session is marked done — a person should look at it, though this \
             Session is not linked to a card, so nothing moved on the board",
            "`unlinked` is the ONE arm that may say the Session has no card"
        );
    }

    /// A `None` bound is not a zero bound. The `ceiling_usd` arm already omits its
    /// figure when there is none (ADR 0082's phantom zero); `max_steps` rendered
    /// `unwrap_or(0)` and so told every such Session it had a 0-step bound — a
    /// number nobody configured, and the one number a person would act on.
    #[test]
    fn a_step_bound_with_no_number_omits_the_figure_instead_of_inventing_zero() {
        let mut advice = refused(REASON_MAX_STEPS);
        advice.max_steps = None;

        let text = sentence_for("sess-1", true, None, &advice);

        assert_eq!(
            text,
            "this Session is marked done, but the chain is at its step bound, so the \
             card stayed put",
            "the sentence without the number, mirroring the ceiling arm's `None`"
        );
        assert!(
            !text.contains("0-step"),
            "and no phantom 0-step bound; got {text}"
        );
    }

    /// The byte-identity pin for the whole table. Four of these sentences are
    /// asserted BY SUBSTRING in `host_tools/tests/verbs.rs` — `not_automatic` via
    /// `done` (:768) and `not automatic` (:899), the advance sentence via the
    /// destination slug `research` (:849), and `max_steps` via `1-step` (:939) plus
    /// the negative `!contains("20-step")` (:944) — and every one of them is read by a
    /// model, so a re-word here is a wire change dressed as a refactor.
    ///
    /// `verbs.rs` cannot pin these any tighter: it drives the verb through `run`, so
    /// the only inputs it can construct are the ones the decider actually emits. This
    /// table calls `sentence_for` directly and asserts EQUALITY against the literal,
    /// not `contains` — a `contains` pin passes when a sentence grows a clause beside
    /// the needle, which is exactly how a model-facing sentence drifts unnoticed.
    ///
    /// The stronger proof lives outside the suite: rendering HEAD's `sentence_for`
    /// beside this one over 9,360 combinations of `(claimed, advance, reason,
    /// max_steps, ceiling_usd, destination, outcome)` produced zero differences outside
    /// the two this commit sets out to make.
    #[test]
    fn every_refusal_sentence_is_pinned_byte_for_byte() {
        let mut ceiling = refused(REASON_COST_CEILING);
        ceiling.ceiling_usd = Some(4.0);

        let mut bound = refused(REASON_MAX_STEPS);
        bound.max_steps = Some(1);

        let mut fell_back = refused(REASON_ADVANCED_UNNAMED_EDGE);
        fell_back.advance = true;

        let mut advanced = refused("advanced");
        advanced.advance = true;

        // The ceiling arm's `None` half: no figure exists to quote, and rendering
        // one would be ADR 0082's phantom zero in a sentence.
        let mut ceilingless = refused(REASON_COST_CEILING);
        ceilingless.ceiling_usd = None;

        for (reason, text, want) in [
            (
                "the row that is not there",
                sentence_for("sess-gone", false, None, &refused("advanced")),
                "mark_done wrote nothing: this frame's origin session id `sess-gone` \
                 matches no Session row, so nothing was flagged and nothing advanced"
                    .to_string(),
            ),
            (
                "max_steps",
                sentence_for("sess-1", true, None, &bound),
                "this Session is marked done, but the chain is at its 1-step bound, so \
                 the card stayed put"
                    .to_string(),
            ),
            (
                "cost_ceiling with a figure",
                sentence_for("sess-1", true, None, &ceiling),
                "this Session is marked done, but the chain has reached its $4.00 \
                 ceiling, so the card stayed put"
                    .to_string(),
            ),
            (
                "cost_ceiling without one",
                sentence_for("sess-1", true, None, &ceilingless),
                "this Session is marked done, but the chain has reached its cost \
                 ceiling, so the card stayed put"
                    .to_string(),
            ),
            (
                "not_automatic",
                sentence_for("sess-1", true, None, &refused(REASON_NOT_AUTOMATIC)),
                "this Session is marked done and flagged for review; this column is \
                 not automatic, so the card stayed put and a person moves it"
                    .to_string(),
            ),
            (
                "already_advanced",
                sentence_for("sess-1", true, None, &refused(REASON_ALREADY_ADVANCED)),
                "this Session is marked done; this handoff has already launched, so \
                 nothing moved again"
                    .to_string(),
            ),
            (
                "unclaimed",
                sentence_for("sess-1", true, None, &refused(REASON_UNCLAIMED)),
                "this Session is marked done; the card did not advance".to_string(),
            ),
            (
                "no_next_stage",
                sentence_for("sess-1", true, None, &refused(REASON_NO_NEXT_STAGE)),
                "this Session is marked done and flagged for review; this column leads \
                 nowhere, so the card stayed put"
                    .to_string(),
            ),
            (
                "advanced (no destination row)",
                sentence_for("sess-1", true, None, &advanced),
                "this Session is marked done and its card advanced to the next column".to_string(),
            ),
            (
                "advanced_unnamed_edge",
                sentence_for("sess-1", true, Some("escalated"), &fell_back),
                "this Session is marked done and its card advanced to the next column \
                 — this column has no transition named `escalated`, so the first one \
                 was taken"
                    .to_string(),
            ),
        ] {
            assert_eq!(
                text, want,
                "the `{reason}` sentence changed byte-for-byte — six of these are \
                 asserted by substring in `host_tools/tests/verbs.rs` and all of them \
                 are read by a model"
            );
        }
    }
}
