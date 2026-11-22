//! Tests for `db/seams.rs`: the two crate-seam impls, at UNIT level.
//!
//! This child holds the two things that need no database harness beyond a
//! throwaway file: the trait-bound INSTANTIATIONS (the proof the S4 ruling asks
//! for — `impl FulcrumPersistence for Db` / `impl TaskStore for Db` must exist and
//! be satisfiable), and the DTO FIELD MAPPING of the write answer, which is the
//! only substance in `seams.rs` (both impls are delegation: zero SQL, no error
//! policy re-spelled).
//!
//! The BEHAVIOURAL half of the seam coverage stays in
//! `src-tauri/tests/fulcrum_seams.rs`, where the full DB harness already lives:
//! the `Arc<dyn FulcrumPersistence>` / `Arc<dyn TaskStore>` round trips over a real
//! database, the artifact key-grammar and size-cap refusals on the seam path, and
//! the crate-side error vocabulary. Those are integration pins by shape — they drive
//! a trait object against a seeded database — and moving them here would move the
//! harness with them. What this child adds is the mirror ADR 0113 asks for: every
//! production sibling has a test child, and `seams.rs` was the one that did not.
//!
//! The import below is also the measurement that kills the stale claim at
//! `fulcrum_seams.rs:1345` ("the `storage/db/tests/` tree cannot see the crate's
//! error family"): it can, and `the_seams_answer_in_the_crate_error_family` uses
//! both crate error types from inside `db/tests/`.

use crate::storage::db::*;

use fulcrum_harness::seams::{FulcrumPersistence, StoreError, TaskStore, TaskStoreError};

use super::support::board_space;

/// (S4's gate, unit half) `Db` IS a `FulcrumPersistence` and IS a `TaskStore`.
///
/// The generic bounds ARE the assertion: neither function can be monomorphised
/// without the real `impl` block in `db/seams.rs`, and `FulcrumPersistence`'s
/// `Send + Sync` supertraits ride along, so this also proves `Db` is shareable
/// behind the `Arc` the crate holds. Deleting either impl is an `E0277` here.
#[test]
fn db_satisfies_both_crate_seams() {
    fn assert_fp<T: FulcrumPersistence>() {}
    fn assert_task_store<T: TaskStore>() {}

    assert_fp::<Db>();
    assert_task_store::<Db>();
}

/// The seams answer in the CRATE's error family, not the desktop's.
///
/// The two return types below are ASCRIBED, so a seam that leaked `DbError`
/// instead of mapping it would not compile — that is the whole point of the pin,
/// and it is the proof `fulcrum_seams.rs`'s "cannot see the crate's error family"
/// note got wrong. Both calls are the benign arm on an empty database (a cost
/// update that matches no row, a board that does not exist), so the test asserts
/// the TYPE and the silent no-op, and leaves the refusals to the integration file.
#[test]
fn the_seams_answer_in_the_crate_error_family() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-seam-errors-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");

    let persistence: Result<(), StoreError> =
        FulcrumPersistence::record_session_cost(&db, "no-such-session", 1.0);
    let board: Result<Vec<fulcrum_harness::seams::BoardRow>, TaskStoreError> =
        TaskStore::list_board(&db, "/seams-never-a-space");

    assert!(
        persistence.is_ok(),
        "a cost update that matches no row is the seam's silent no-op, not an error"
    );
    assert!(
        board
            .as_ref()
            .expect("an unseen Space is an empty board, not a failure")
            .is_empty(),
        "the board seam answers `[]` for a Space with no cards"
    );
}

/// `desktop_row_to_crate_row`, field for field, on the `create_task` answer.
///
/// The mapping is the only substance in the write path of `impl TaskStore for Db`,
/// and until now it was asserted only INDIRECTLY (a seam test that read back a card
/// and looked at one or two fields). Every one of the ten fields is asserted here
/// against the STORED row, read through the inherent verb. `spec_path`, `sort_order`
/// and `updated_at` had NEVER been asserted through the seam at all.
///
/// One honest limit, stated rather than glossed: on a FRESH card both clock columns
/// come from the same `now_ms()`, so this test proves both fields are CARRIED and
/// cannot prove WHICH clock each carries. The `edit_task` test below is the arm that
/// distinguishes them, and it is the one a swapped clock mapping reddens.
#[test]
fn create_task_maps_every_field_of_the_desktop_row() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-seam-map-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("seams");

    // QUALIFIED calls throughout: `Db` carries inherent methods with these exact
    // names and Rust prefers inherent ones, so `self.method(…)` would reach the
    // SQLite verb and never the trait — the same rule `db/seams.rs` spells.
    let created = TaskStore::create_task(&db, &space, "a card", Some("a body"), None)
        .expect("the seam creates a card");
    // The two clock arms at the end prove CARRIAGE, not which clock — see the doc.
    let stored = Db::get_task(&db, &created.id)
        .expect("get_task")
        .expect("the card the seam just made");

    assert_eq!(created.id, stored.id, "`id` crosses");
    assert_eq!(
        created.space_path, stored.space_path,
        "`space_path` crosses"
    );
    assert_eq!(
        created.number, stored.number as u32,
        "`number` narrows i64 → u32 (the desktop's is `MAX(number) + 1`, positive \
         and small by construction — ADR 0090)"
    );
    assert_eq!(created.title, stored.title, "`title` crosses");
    assert_eq!(
        created.body, stored.body,
        "`body` crosses, `Option` and all"
    );
    assert_eq!(
        created.spec_path, stored.spec_path,
        "`spec_path` crosses — and a fresh card carries None, so this is the arm \
         that proves the field is MAPPED and not defaulted"
    );
    assert_eq!(
        created.stage_slug, stored.stage_slug,
        "`stage_slug` crosses"
    );
    assert_eq!(
        created.sort_order, stored.sort_order,
        "`sort_order` crosses (never asserted through the seam before)"
    );
    // Both clock arms prove the field is CARRIED; neither can prove WHICH clock it
    // carries, because `create_task` stamps the two columns from one `now_ms()` and a
    // fresh card therefore has `created_at == updated_at`. The `edit_task` test below
    // is the arm that distinguishes the slots (it pauses first, so they differ).
    assert_eq!(
        created.created_at, stored.created_at,
        "`created_at` crosses the seam"
    );
    assert_eq!(
        created.updated_at, stored.updated_at,
        "`updated_at` crosses (never asserted through the seam before)"
    );
}

/// The same mapping on the `edit_task` answer, plus the seam's OWN two-state rule.
///
/// Two facts, both about `impl TaskStore for Db` rather than about the SQL:
/// `Option<&str> → FieldPatch` maps `None → Keep` (so a model's edit leaves an
/// untouched field exactly as stored — `FieldPatch::Clear` is unreachable from the
/// published wire), and the answer the seam hands back is the re-read row mapped by
/// the SAME helper `create_task` uses.
#[test]
fn edit_task_maps_the_same_ten_fields_and_keeps_what_the_seam_was_not_given() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-seam-edit-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let space = board_space("seams");
    let created = TaskStore::create_task(&db, &space, "a card", Some("a body"), None)
        .expect("the seam creates a card");
    // THE SLEEP IS THE NON-VACUITY OF THE CLOCK ARMS BELOW, so it is load-bearing
    // and not decoration. `create_task` writes ONE `now_ms()` into BOTH clock
    // columns, so on a fresh card `created_at == updated_at` and a mapping that put
    // `created_at` into the crate DTO's `updated_at` slot would survive every
    // assertion in the test above. `edit_task` stamps `updated_at` unconditionally,
    // so after this pause the stored `updated_at` is strictly LATER than the stored
    // `created_at`, and only a correctly-mapped `updated_at` can equal it. Measured:
    // with the sleep the swapped mapping reddens this test; without it, not.
    std::thread::sleep(std::time::Duration::from_millis(5));

    // `spec_path` is the ONLY patch this edit sends, so every other field in the
    // answer must be exactly what the create answer carried.
    let edited = TaskStore::edit_task(&db, &created.id, None, None, Some("docs/spec.md"))
        .expect("the seam patches one field");
    let stored = Db::get_task(&db, &created.id)
        .expect("get_task")
        .expect("the card the seam just patched");

    assert_eq!(
        edited.spec_path.as_deref(),
        Some("docs/spec.md"),
        "a `Some` spec_path reaches `FieldPatch::Set` and lands"
    );
    assert_eq!(
        edited.spec_path, stored.spec_path,
        "and the answer is the STORED value, not the argument echoed back"
    );
    assert_eq!(
        (edited.id.as_str(), edited.title.as_str(), edited.number),
        (created.id.as_str(), created.title.as_str(), created.number),
        "the three fields this edit never named come back untouched"
    );
    assert_eq!(
        (edited.body.as_deref(), edited.stage_slug.as_str()),
        (Some("a body"), created.stage_slug.as_str()),
        "`None` maps to `FieldPatch::Keep`, so `body` still holds its text — a \
         `None → Clear` mapping would blank it here and this is where that shows"
    );
    assert_eq!(
        (edited.sort_order, edited.space_path.as_str()),
        (created.sort_order, created.space_path.as_str()),
        "`sort_order` and `space_path` survive the edit answer too"
    );
    assert_eq!(
        edited.created_at, created.created_at,
        "`created_at` is not re-stamped by a patch"
    );
    assert_eq!(
        edited.updated_at, stored.updated_at,
        "`updated_at` crosses the seam from the re-read row (`edit_task` stamps it \
         unconditionally), so the answer's clock IS the stored clock"
    );
}
