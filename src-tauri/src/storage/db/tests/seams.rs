//! Tests for `db/seams.rs`: the crate-seam impl, at UNIT level.
//!
//! This child holds the two things that need no database harness beyond a throwaway
//! file: the trait-bound INSTANTIATION (the proof the S4 ruling asks for —
//! `impl FulcrumPersistence for Db` must exist and be satisfiable), and the answers
//! that seam gives in the CRATE's error family.
//!
//! # There used to be four pins here, and two of them moved
//!
//! `db_satisfies_both_crate_seams` and `the_seams_answer_in_the_crate_error_family`
//! each had a TaskStore half, and `create_task_maps_every_field_of_the_desktop_row`
//! plus `edit_task_maps_the_same_ten_fields_and_keeps_what_the_seam_was_not_given`
//! tested the trait impl's DTO mapping. ADR 0102 / issue #183 F3 deleted the trait, so
//! all four lost their subject. The two that tested the MAPPING — the one piece of
//! substance the impl had — are not deleted, they moved to
//! `agent/host_tools/tests/mapping.rs` with the mapping itself, keeping their
//! assertions (including the load-bearing 5 ms sleep that makes the clock arm
//! non-vacuous). The two seam-bound pins here keep only their persistence half,
//! because the trait they asserted against is gone from the crate.
//!
//! The BEHAVIOURAL half of the seam coverage stays in `src-tauri/tests/fulcrum_seams.rs`,
//! where the full DB harness already lives: the `Arc<dyn FulcrumPersistence>` round
//! trip over a real database. That is an integration pin by shape — it drives a trait
//! object against a seeded database — and moving it here would move the harness with
//! it. What this child adds is the mirror ADR 0113 asks for: every production sibling
//! has a test child, and `seams.rs` was the one that did not.

use crate::storage::db::*;

use fulcrum_harness::seams::{FulcrumPersistence, StoreError};

use super::support::board_space;

/// (S4's gate, unit half) `Db` IS a `FulcrumPersistence`.
///
/// The generic bound IS the assertion: the function cannot be monomorphised without
/// the real `impl` block in `db/seams.rs`, and `FulcrumPersistence`'s `Send + Sync`
/// supertraits ride along, so this also proves `Db` is shareable behind the `Arc` the
/// crate holds. Deleting the impl is an `E0277` here.
///
/// The name used to be `db_satisfies_both_crate_seams`. There is now ONE crate seam
/// on this type, not two, and the name says so — a name that promises two and asserts
/// one is the kind of stale claim that survives a deletion unnoticed.
#[test]
fn db_satisfies_the_crate_persistence_seam() {
    fn assert_fp<T: FulcrumPersistence>() {}

    assert_fp::<Db>();
}

/// The persistence seam answers in the CRATE's error family, not the desktop's.
///
/// The return type below is ASCRIBED, so a seam that leaked `DbError` instead of
/// mapping it would not compile — that is the whole point of the pin. The call is the
/// benign arm on an empty database (a cost update that matches no row), so this
/// asserts the TYPE and the silent no-op, and leaves the refusals to the integration
/// file.
#[test]
fn the_persistence_seam_answers_in_the_crate_error_family() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-seam-errors-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");

    let persistence: Result<(), StoreError> =
        FulcrumPersistence::record_session_cost(&db, "no-such-session", 1.0);

    assert!(
        persistence.is_ok(),
        "a cost update that matches no row is the seam's silent no-op, not an error"
    );
}

/// The board verbs still answer in the DESKTOP's error family — and the host tools
/// fold that into their own sentence type through ONE `From` impl.
///
/// The sibling of the pin above, and the half that INVERTED with the deletion: the
/// board verbs were reached through a trait whose error type the crate owned, and they
/// are now reached through `agent/host_tools/exec/` (the dispatch in `exec/mod.rs`,
/// the verb bodies in `exec/board.rs`), which folds `BoardError` into
/// `HostToolError` (`storage/db/mod.rs`) exactly as the seam used to fold it into the
/// crate's family. The ascribed types below are the assertion — change the `From`
/// impl's target and this stops compiling.
///
/// The three sentences asserted are the ones the MODEL reads verbatim (the frame
/// carries a bare `String`), which is what makes this a wording pin and not only a
/// type pin: `docs/features/task-board-known-gaps.md` §2 cites them.
#[test]
fn the_board_verbs_fold_into_the_host_tool_error_with_their_sentences_intact() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-host-tool-errors-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("host-tool-errors");

    // A dangling card id is the `NotFound` arm, and its sentence is `BoardError`'s
    // own `Display` rendered ONCE — never re-spelled per mapping arm, which is how a
    // `#[error(...)]` edit and a mapping table drift apart.
    let absent: Result<MoveOutcome, HostToolError> =
        Db::move_task(&db, &space, "tsk_absent", "doing").map_err(Into::into);
    let err = match absent {
        Ok(_) => panic!("a move of a card that does not exist must refuse"),
        Err(e) => e,
    };
    assert!(
        matches!(&err, HostToolError::NotFound { message } if message.contains("tsk_absent")),
        "`NotFound` naming the id — the model cannot act on a refusal that does not \
         say what it rejected. Got {err:?}"
    );
    assert_eq!(
        err.to_string(),
        "no task with id tsk_absent",
        "the sentence is `BoardError`'s own, byte for byte — this is the string the \
         Worker shows the model, and the one docs/features/task-board-known-gaps.md \
         §2 cites"
    );

    // An artifact key outside the grammar is `Invalid`, and keeps the GRAMMAR in the
    // sentence so the model self-corrects without a second call.
    let created = Db::create_task(&db, &space, "a card", None, None).expect("create_task");
    let bad_key: Result<ArtifactMeta, HostToolError> =
        Db::write_artifact(&db, &created.id, "My Spec", "x").map_err(Into::into);
    let err = match bad_key {
        Ok(_) => panic!("a key outside the grammar must refuse"),
        Err(e) => e,
    };
    assert!(
        matches!(&err, HostToolError::Invalid { message }
            if message.contains("My Spec") && message.contains("[a-z0-9][a-z0-9-]{0,39}")),
        "`Invalid`, naming the key AND the grammar — got {err:?}"
    );

    // And a `DbError` (the board read's enrichment path is the only one a host tool
    // can hit it on) folds to `Io` with its `sqlite error: ` prefix PRESERVED, so
    // which layer failed survives inside the sentence.
    let db_err: DbError = rusqlite::Error::QueryReturnedNoRows.into();
    let folded: HostToolError = db_err.into();
    assert_eq!(
        folded.to_string(),
        "sqlite error: Query returned no rows",
        "the `sqlite error: ` prefix survives the `Sqlite → Io` fold — a model that \
         is told the disk failed looks in the wrong place"
    );
}
