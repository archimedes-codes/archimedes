//! The `BoardError → TasksError` wire map, extracted from [`agent::errors`].
//!
//! WHY THIS FILE EXISTS. `agent/errors.rs` is baselined at exactly its current
//! code-line count in `scripts/file-size-baseline.txt`, and the size ratchet
//! refuses it growing by ONE line. The map below is the `BoardError` arm table
//! the Tasks commands answer on, and the tasks board grows new storage refusals
//! (the `stages.next_outcomes` edge-label arity check is one), so a table that
//! gains an arm on a feature cannot live in a file that may not gain a line.
//! Extracting it is what makes the arm addable at all.
//!
//! WHY THIS IS LEGAL UNDER ADR 0063. That ADR is NOT a one-file rule — its
//! 2026-11-20 amendment says so twice in its own words: *"The error type is
//! chosen by the wire, not by the file"* and *"The discriminator is the wire
//! surface a command answers on, never the module it is declared in."* What the
//! ADR actually requires is that a family's **enum + `kind()` + its hand-written
//! `From … for tauri::ipc::InvokeError`** stay together, because that trio is
//! where the exhaustive-match-and-no-catch-all property lives and where
//! `#[error(…)]` sits beside its variant. NONE of that trio moved here:
//! `TasksError`, its `kind()`, its `thiserror` attribute and its
//! `impl From<TasksError> for tauri::ipc::InvokeError` all remain in
//! [`agent::errors`]. What moved is one step BELOW the wire — the
//! storage→command conversion that turns a `BoardError` into a `TasksError`
//! before the wire impl ever sees one. ADR 0063's own header says the same about
//! `DbError`: the error type is chosen by the wire, and this is the layer where
//! a foreign type is folded INTO a wire family, not a wire family's own envelope.
//!
//! The one layout ADR 0063 explicitly FORBIDS is a shared `wire.rs` holding all
//! twelve `impl From<…> for tauri::ipc::InvokeError` — separating each family's
//! wire arm from its own enum. This is not that: it holds zero `InvokeError`
//! impls, and `src-tauri/tests/error_wire_gate.rs` derives its family set from
//! `include_str!` of `errors.rs` alone, so a family moving its envelope out would
//! go red there naming itself.
//!
//! [`agent::errors`]: crate::agent::errors

use super::errors::TasksError;
use crate::storage::BoardError;

/// The board's storage errors map ONTO the wire family, and the two absence
/// cases keep their identity: a missing card and a bad slug must not arrive as a
/// generic database failure, because the frontend's message and the model's next
/// move both depend on which of the two it was.
///
/// The seven #179 Stage refusals all ride `NotFound`, and that is a decision
/// rather than a default. Each of them composes its own complete sentence in
/// `BoardError`'s `Display` — the card count, the pointing Stages, the legal
/// destinations — and that sentence IS the answer: `TasksBoard.tsx` renders it
/// through `IpcErrorLine` with `role="alert"`, and `store/tasks.ts`'s optimistic
/// write reverts on ANY rejection kind. A distinct wire `kind` for each would add
/// eight strings to the wire contract that no reader branches on, and `kind()`
/// exists to be branched on. `NotFound` is the arm that already means "what you
/// named is not what is here, and here is what is" — ADR 0090's rule, which every
/// one of these refusals is an instance of.
impl From<BoardError> for TasksError {
    fn from(e: BoardError) -> Self {
        match e {
            BoardError::Sqlite(e) => TasksError::Database(e.to_string()),
            BoardError::MissingTask(id) => TasksError::NotFound(format!("no task with id {id}")),
            BoardError::MissingStage { wanted, available } => {
                TasksError::NotFound(if available.is_empty() {
                    format!("no stage {wanted} in this space")
                } else {
                    format!("no stage {wanted} in this space (valid stages: {available})")
                })
            }
            // Each arm spells its own `Display` sentence rather than calling
            // `e.to_string()`, matching the two arms above: the wire message is
            // written HERE, in one place, so a `BoardError` comment change cannot
            // silently change what a user reads.
            BoardError::StageNotEmpty {
                slug,
                count,
                available,
            } => TasksError::NotFound(format!(
                "stage {slug} has {count} card(s) — delete or move them first \
                 (valid stages: {available})"
            )),
            BoardError::StageReferenced { slug, referrers } => TasksError::NotFound(format!(
                "stage {slug} cannot be deleted — another stage's transitions lead here \
                 ({referrers})"
            )),
            BoardError::LastStage { slug } => TasksError::NotFound(format!(
                "stage {slug} is this space's last column and cannot be deleted"
            )),
            BoardError::StageSlugTaken { slug, available } => TasksError::NotFound(format!(
                "a stage with slug {slug} already exists in this space \
                 (valid slugs: {available})"
            )),
            BoardError::EmptyStageSlug => {
                TasksError::NotFound("cannot create a stage with an empty slug".to_string())
            }
            BoardError::StrictMoveRefused { from, to, allowed } => TasksError::NotFound(format!(
                "cannot move to {to} from {from} — allowed: {allowed}"
            )),
            BoardError::SelfLoop { slug } => {
                TasksError::NotFound(format!("stage {slug} cannot lead to itself"))
            }
            // The arity refusal rides `NotFound` with the Stage refusals above it
            // and re-spells its own sentence for the same reason they do: nothing
            // branches on a distinct `kind` here — `store/tasks.ts` reverts its
            // optimistic paint on ANY rejection kind and renders `message` — so a
            // new wire string would be one more no reader reads. The sentence names
            // BOTH counts, which is the whole answer ("my outcome list is the wrong
            // length, and here is the length it should have been").
            BoardError::EdgeOutcomeCount {
                slug,
                slugs,
                outcomes,
            } => TasksError::NotFound(format!(
                "stage {slug} got {outcomes} edge label(s) for {slugs} edge(s) — \
                 next_outcomes must have EXACTLY one entry per next_slugs entry, \
                 using null for an edge that carries no label"
            )),
            // The two artifact refusals keep their OWN kinds and their own payload
            // fields, and that is not a style choice. Unlike the seven Stage
            // refusals above, which ride `NotFound` because nothing branches on
            // them, `bad_artifact_key` and `artifact_too_large` are strings the
            // frontend already branches on (`store/tasks.test.ts` asserts on the
            // first), and `artifact_too_large` carries `size`/`max` as envelope
            // numbers. So these two map VARIANT TO VARIANT and re-spell nothing:
            // unlike every arm above, no sentence is written here, which is why the
            // wire message cannot drift from the storage layer's `Display` — there
            // is only one `Display`, and both doors reach it. That is what lets
            // storage own these rules as the `TaskStore` backstop without changing
            // one character of what a person who came through the command's own
            // pre-flight reads. `tasks_error_kinds_are_the_wire_strings` pins the
            // kinds; `the_storage_artifact_refusals_keep_the_command_envelope_exactly`
            // pins the whole envelope, both doors against each other.
            BoardError::BadArtifactKey { key } => TasksError::BadArtifactKey(key),
            BoardError::ArtifactTooLarge { size, max } => {
                TasksError::ArtifactTooLarge { size, max }
            }
            // `EmptyTitle` maps the SAME way — VARIANT TO VARIANT, re-spelling
            // nothing — for the identical reason: `BoardError::EmptyTitle`'s
            // `Display` is byte-identical to `TasksError::EmptyTitle`'s by
            // requirement, so there is no sentence to write here and therefore no
            // second place for the wire message to drift. `kind()` needs no new
            // arm; `"empty_title"` already exists and is already what
            // `store/tasks.ts` and `IpcErrorLine` speak. Unlike the seven Stage
            // refusals above, which each re-spell their own sentence into
            // `NotFound`, this one has only ever had the one sentence, and
            // `the_storage_title_refusal_keeps_the_command_envelope_exactly` pins
            // the whole envelope with the two doors against each other.
            BoardError::EmptyTitle => TasksError::EmptyTitle,
        }
    }
}
