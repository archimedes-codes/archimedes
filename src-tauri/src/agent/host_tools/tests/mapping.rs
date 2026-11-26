//! The field-for-field DTO mapping, asserted against the STORED row.
//!
//! These two pins are carried over from `storage/db/tests/seams.rs`, where they
//! tested `impl TaskStore for Db`'s mapping helpers. The trait is deleted (ADR 0102 /
//! issue #183 F3) and the mapping it held moved into the executor arms, so the pins
//! move with it — the Mirror rule wants the test beside the code it guards.
//!
//! They are NOT redundant with `shape.rs`. That file asserts the load-bearing KEYS
//! are present; this one asserts every FIELD CARRIES the right VALUE and that the
//! `None → FieldPatch::Keep` two-state fold behaves. A mapping that put the wrong
//! card's title in `title` would sail through `shape.rs` and redden here.

use serde_json::json;

use crate::agent::host_tools::run;
use crate::storage::Db;

fn seeded(prefix: &str, space: &str) -> (crate::test_support::ScratchDir, std::sync::Arc<Db>) {
    let dir = crate::test_support::ScratchDir::in_env_temp(prefix, "scratch");
    let db = std::sync::Arc::new(Db::open(&dir.join("t.db")).expect("db should open"));
    db.get_board(space).expect("get_board seeds the stages");
    (dir, db)
}

/// Every field of the `create_task` answer, against the stored row.
///
/// Ten fields, each asserted against the row read back through the INHERENT verb — so
/// a mapping that renamed, dropped or re-derived a field reddens on the field's own
/// name. `spec_path`, `sort_order` and `updated_at` had never been asserted through
/// the write answer at all before this; they stay asserted.
///
/// One honest limit, stated rather than glossed: on a FRESH card both clock columns
/// come from the same `now_ms()`, so this proves both fields are CARRIED and cannot
/// prove WHICH clock each carries. The `edit_task` test below is the arm that
/// distinguishes them, and it is the one a swapped clock mapping reddens.
#[tokio::test]
async fn create_task_answers_every_field_of_the_stored_row() {
    let (_dir, db) = seeded("ht-map-create-", "/host-tools/map-create");

    let created = run(
        &db,
        "create_task",
        json!({
            "space_path": "/host-tools/map-create",
            "title": "a card",
            "body": "a body",
        }),
    )
    .await
    .expect("create_task");
    let answer = created.details.as_ref().expect("the new row rides details")["task"].clone();
    let stored = Db::get_task(&db, answer["id"].as_str().expect("an id"))
        .expect("get_task")
        .expect("the card the tool just made");

    assert_eq!(answer["id"], stored.id, "`id` crosses");
    assert_eq!(
        answer["spacePath"], stored.space_path,
        "`space_path` crosses, and on the camelCase wire key"
    );
    assert_eq!(
        answer["number"], stored.number as u32,
        "`number` narrows i64 → u32 (the desktop's is `MAX(number) + 1`, positive and \
         small by construction — ADR 0090)"
    );
    assert_eq!(answer["title"], stored.title, "`title` crosses");
    assert_eq!(
        answer["body"],
        json!(stored.body),
        "`body` crosses, `null` and all"
    );
    assert_eq!(
        answer["specPath"],
        json!(stored.spec_path),
        "`spec_path` crosses — and a fresh card carries `null`, so this is the arm \
         that proves the field is MAPPED and not defaulted"
    );
    assert_eq!(
        answer["stageSlug"], stored.stage_slug,
        "`stage_slug` crosses"
    );
    assert_eq!(
        answer["sortOrder"], stored.sort_order,
        "`sort_order` crosses"
    );
    // Both clock arms prove the field is CARRIED; neither can prove WHICH clock it
    // carries, because `create_task` stamps both columns from one `now_ms()`.
    assert_eq!(
        answer["createdAt"], stored.created_at,
        "`created_at` crosses"
    );
    assert_eq!(
        answer["updatedAt"], stored.updated_at,
        "`updated_at` crosses"
    );
}

/// The same mapping on the `edit_task` answer, plus the two-state fold.
///
/// Two facts: an absent wire field maps to `FieldPatch::Keep` (so a model's edit
/// leaves an untouched field exactly as stored — `Clear` is unreachable from the wire
/// this spec advertises), and the answer is the re-read row, mapped the same way
/// `create_task` maps its own.
#[tokio::test]
async fn edit_task_answers_the_same_fields_and_keeps_what_the_call_did_not_name() {
    let (_dir, db) = seeded("ht-map-edit-", "/host-tools/map-edit");
    let created = run(
        &db,
        "create_task",
        json!({ "space_path": "/host-tools/map-edit", "title": "a card", "body": "a body" }),
    )
    .await
    .expect("create_task");
    let made = created.details.as_ref().expect("details")["task"].clone();
    let task_id = made["id"].as_str().expect("an id").to_string();

    // THE SLEEP IS THE NON-VACUITY OF THE CLOCK ARM BELOW, so it is load-bearing and
    // not decoration. `create_task` writes ONE `now_ms()` into BOTH clock columns, so
    // on a fresh card `created_at == updated_at` and a mapping that swapped the two
    // slots would survive every assertion above. `edit_task` stamps `updated_at`
    // unconditionally, so after this pause the stored `updated_at` is strictly LATER
    // than the stored `created_at`, and only a correctly-mapped `updated_at` can equal
    // it. Measured on the original: with the sleep the swapped mapping reddens this
    // test; without it, not.
    std::thread::sleep(std::time::Duration::from_millis(5));

    // `spec_path` is the ONLY field this edit names, so every other field in the
    // answer must be exactly what the create answer carried.
    let edited = run(
        &db,
        "edit_task",
        json!({ "task_id": task_id, "spec_path": "docs/spec.md" }),
    )
    .await
    .expect("edit_task patches one field");
    let answer = edited.details.as_ref().expect("details")["task"].clone();
    let stored = Db::get_task(&db, &task_id)
        .expect("get_task")
        .expect("the card the tool just patched");

    assert_eq!(
        answer["specPath"], "docs/spec.md",
        "a named `spec_path` reaches `FieldPatch::Set` and lands"
    );
    assert_eq!(
        answer["specPath"],
        json!(stored.spec_path),
        "and the answer is the STORED value, not the argument echoed back"
    );
    assert_eq!(
        (answer["id"].as_str(), answer["title"].as_str()),
        (made["id"].as_str(), made["title"].as_str()),
        "the fields this edit never named come back untouched"
    );
    assert_eq!(
        answer["body"], "a body",
        "an ABSENT `body` maps to `FieldPatch::Keep`, so `body` still holds its text \
         — an `absent → Clear` mapping would blank it here and this is where that \
         shows"
    );
    assert_eq!(
        (answer["sortOrder"].clone(), answer["spacePath"].clone()),
        (made["sortOrder"].clone(), made["spacePath"].clone()),
        "`sort_order` and `space_path` survive the edit answer too"
    );
    assert_eq!(
        answer["createdAt"], made["createdAt"],
        "`created_at` is not re-stamped by a patch"
    );
    assert_eq!(
        answer["updatedAt"], stored.updated_at,
        "`updated_at` crosses from the re-read row (`edit_task` stamps it \
         unconditionally), so the answer's clock IS the stored clock"
    );
    assert_ne!(
        stored.updated_at, stored.created_at,
        "the fixture state that makes the clock arm above a real pin: the pause \
         landed, so the two stamps DIFFER and a swapped mapping cannot pass"
    );
}
