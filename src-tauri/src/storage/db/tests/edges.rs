//! Tests for `db/edges.rs`: the graph question the forward gate asks — is `to`
//! reachable from `from` by following this Space's `next_slugs` edges (D8), with
//! the `sort_order + 1` fallback an UNCONFIGURED column answers with (D15).
//!
//! These are BFS pins and nothing else. The gate that ACTS on the answer
//! (`MoveAuthor::Model` + [`BoardError::ForwardMoveRefused`]) is a `Db::move_task`
//! subject and is pinned in [`super::tasks`]; the sentence the refusal carries is
//! pinned there and again on the host-tool path in
//! `agent/host_tools/tests/verbs.rs`.
//!
//! WHY EVERY TEST HERE GOES THROUGH A LOCKED `&Connection` and not a `Db` verb.
//! `forward_reachable` takes `conn: &Connection` because it runs INSIDE
//! `move_task`'s own guard, and ADR 0119 §2 records that the connection mutex is
//! NOT reentrant — a `Db::list_stages` call from in there deadlocks rather than
//! reads. The mirror rule wants the test to call the function the way production
//! does, so the helper below takes the guard and hands it down. That is also what
//! makes these tests immune to the shape of `move_task`: a BFS that answers wrong
//! reddens here naming the graph, not in a gate test where the reader has to work
//! out which of the two gates spoke.
//!
//! WHY THIS FILE CARRIES ITS `expect("db mutex poisoned")` SITES, and where they are
//! (AGENTS.md's poisoned-mutex rule): [`reachable`], to hand the BFS the guard it is
//! called under in production, and [`raw_execute`], to write a `stages` value no `Db`
//! verb would accept — an undecodable `next_slugs` cell, and a `sort_order` two
//! columns are not supposed to share. Both guard `Db`'s ONE shared
//! `rusqlite::Connection` — a single, shared resource a panic mid-transaction can
//! leave genuinely unusable — so the panic spelling is the correct one and the worked
//! example to cite is the production `record_messages_batch` (`docs/agents/census.md`
//! keeps the instrument, and it counts no site here on purpose: a number in a comment
//! is the thing this branch's other fix exists to remove).

use crate::storage::db::*;

use super::support::*;

/// The BFS, called the way `move_task` calls it: `Db`'s guard, handed down.
///
/// Panics on a `BoardError` because the only variant `forward_reachable` can
/// raise is `Sqlite`, and a read of a table the test just wrote has no honest
/// reason to fail — a real one is a bug in the query, and this says so.
fn reachable(db: &Db, space: &str, from: &str, to: &str) -> bool {
    // One of this file's TWO panic sites — see the header for the rationale.
    let guard = db.conn.lock().expect("db mutex poisoned");
    super::super::edges::forward_reachable(&guard, space, from, to).expect("the BFS only reads")
}

/// One raw `UPDATE` on `stages`, for the two shapes no `Db` verb will write.
///
/// Both cases below need a row a writer refuses to produce — a `next_slugs` cell that
/// is not a JSON array (`set_stage_next` validates and would reject it), and a
/// `sort_order` two columns share (`reorder_stages` writes a dense 0-based index and
/// cannot collide). The FK-free, UNIQUE-free `stages` schema makes both reachable from
/// a foreign writer, which is exactly why the BFS must survive them, so the test that
/// pins that survival has to write them.
///
/// ONE helper and not two inline lock-and-execute blocks, so the file holds one panic
/// site for raw writes instead of one per test — the header's site count is a claim a
/// reader checks, and a second `expect` added three tests away would make it false.
fn raw_execute(db: &Db, sql: &str, space: &str) {
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(sql, params![space])
        .expect("the raw write");
}

/// (D8's headline case) a CONFIGURED chain is walked edge by edge, forward.
///
/// Three assertions, because a BFS that returns true for everything passes with
/// the first alone: the far end of the chain IS reachable, a column BEYOND the
/// chain's end is NOT, and the walk is DIRECTIONAL — following the edges backwards
/// is not reachability, so `done` reaches nothing.
///
/// `doing` is configured `[]` rather than left NULL, and that is not decoration:
/// the fallback is PER ROW (`nextStepSlugs` is called once per column and each
/// column answers its own `nextSlugs ?? sortOrder + 1`), so a NULL `doing` would
/// contribute the `sort_order + 1` neighbour and point at `done` itself. The second
/// assertion needs a chain that actually ENDS, and only a configured `[]` ends it.
/// [`forward_reachable_mixes_a_configured_row_with_a_null_one`] pins that mixing.
#[test]
fn forward_reachable_walks_a_configured_chain_and_only_forwards() {
    let (_dir, db, space) = seeded("edges-chain");
    db.get_board(&space).expect("seed the five columns");
    // backlog → research → approved → doing, and `doing` is a configured dead end.
    db.set_stage_next(&space, "backlog", &["research".to_string()], &[None])
        .expect("backlog → research");
    db.set_stage_next(&space, "research", &["approved".to_string()], &[None])
        .expect("research → approved");
    db.set_stage_next(&space, "approved", &["doing".to_string()], &[None])
        .expect("approved → doing");
    db.set_stage_next(&space, "doing", &[], &[])
        .expect("and the chain ENDS at doing");

    assert!(
        reachable(&db, &space, "backlog", "doing"),
        "three hops away is still forward — a single-declared-edge test would \
         call this a skip and D8 refuses that definition"
    );
    assert!(
        !reachable(&db, &space, "backlog", "done"),
        "a column nothing leads to is NOT reachable, however far right it sits"
    );
    assert!(
        !reachable(&db, &space, "doing", "backlog"),
        "reachability follows the arrows: a backward move is not forward, which \
         is what keeps D10's backward door open"
    );
}

/// (the fallback is PER ROW, like `nextStepSlugs`) a configured row and a NULL row
/// in the same walk each answer their own way, and the traversal follows both.
///
/// `nextStepSlugs(columns, from)` takes ONE column and is called once per column
/// (`workflowGraphLayout.ts` loops it over every stage), so the fallback is not a
/// board-wide mode you opt out of by configuring one column — it is that column's
/// answer. Rust matches it row for row, and this is the pin that says so, because
/// it is the semantics that decides the "unreachable further right" case: see
/// [`forward_reachable_is_false_for_an_unreachable_target_further_right_on_a_configured_board`].
#[test]
fn forward_reachable_mixes_a_configured_row_with_a_null_one() {
    let (_dir, db, space) = seeded("edges-mixed");
    db.get_board(&space).expect("seed");
    db.set_stage_next(&space, "backlog", &["approved".to_string()], &[None])
        .expect("backlog SKIPS research and points at approved");

    // `research` is NULL, so its row still contributes `approved → doing`'s order
    // neighbour even though a DIFFERENT row on this board is configured.
    assert!(
        reachable(&db, &space, "research", "doing"),
        "a NULL row still falls back beside a configured one — the fallback is \
         per row, not a board-wide mode (`nextStepSlugs` answers per column)"
    );
    assert!(
        reachable(&db, &space, "backlog", "approved"),
        "and the configured row's own edge is followed just as well"
    );
    assert!(
        !reachable(&db, &space, "backlog", "research"),
        "skipping a column by configuration does not make it reachable — the walk \
         went PAST it"
    );
}

/// (a branch, the shape ADR 0099 was written for) every edge of a column is a
/// hop, and a sibling branch is reachable even when the OTHER branch is the one
/// that continues.
///
/// This is the case a `sort_order` comparison gets wrong: `discuss → research`
/// points BACKWARDS against render order, and a positional test would call it a
/// backward move. Here the branch that sits LEFT of the origin in render order is
/// still forward, because an edge points at it.
#[test]
fn forward_reachable_follows_every_edge_of_a_branch_not_just_the_head() {
    let (_dir, db, space) = seeded("edges-branch");
    db.get_board(&space).expect("seed");
    // backlog → [research, done]: one column, two doors, and the second one jumps
    // to the LAST column.
    db.set_stage_next(
        &space,
        "backlog",
        &["research".to_string(), "done".to_string()],
        &[None, None],
    )
    .expect("backlog branches");
    // research points BACK at backlog's own neighbour, not forward.
    db.set_stage_next(&space, "research", &["approved".to_string()], &[None])
        .expect("research → approved");

    assert!(
        reachable(&db, &space, "backlog", "done"),
        "the second edge of a branch is as reachable as the first"
    );
    assert!(
        reachable(&db, &space, "backlog", "approved"),
        "and the branch that continues two hops away is reachable through it"
    );
    assert!(
        !reachable(&db, &space, "research", "backlog"),
        "the branch does not invent an edge back"
    );
}

/// (a cycle, legal today — only a SELF-loop is refused) the visited set
/// terminates the walk, and BOTH directions of the cycle classify as forward.
///
/// Both directions is the point, and it is the answer to "isn't B → A backward?".
/// No. On a cycle every edge is forward, because forward is reachability (D8) and
/// an edge points that way. A gate that called one half of a cycle backward would
/// be reading `sort_order` through the back door.
///
/// Termination is pinned by the fact that this test RETURNS. A visited set that
/// looped forever hangs the test rather than failing it, which is the honest
/// limit of a unit pin on a non-terminating walk — so the two assertions below
/// are what a reviewer can actually read.
#[test]
fn forward_reachable_terminates_on_a_cycle_and_calls_both_directions_forward() {
    let (_dir, db, space) = seeded("edges-cycle");
    db.get_board(&space).expect("seed");
    db.set_stage_next(&space, "backlog", &["research".to_string()], &[None])
        .expect("backlog → research");
    db.set_stage_next(&space, "research", &["backlog".to_string()], &[None])
        .expect("research → backlog: a two-column cycle, and legal");

    assert!(
        reachable(&db, &space, "backlog", "research"),
        "the forward half of the cycle"
    );
    assert!(
        reachable(&db, &space, "research", "backlog"),
        "and the half that a `sort_order` comparison would call backward — an \
         edge points at it, so it IS forward"
    );
}

/// (D15 — the case the first draft got backwards) a `NULL` origin on a DEFAULT
/// board still has a shape: the `sort_order + 1` fallback supplies the edge, so
/// the LAST column IS reachable from the FIRST and a forward move IS refused.
///
/// Without the fallback a reachability test over an empty edge set refuses nothing
/// on every Space the app itself creates — `seed_default_stages` deliberately
/// leaves `next_slugs` NULL — and the gate is inert everywhere. This is also the
/// semantics `nextStepSlugs` (`src/lib/workflowGraph.ts`) already implements, which
/// is why Rust ports it rather than inventing a stricter reading of `NULL`.
#[test]
fn forward_reachable_uses_the_sort_order_fallback_when_next_slugs_is_null() {
    let (_dir, db, space) = seeded("edges-null-chain");
    db.get_board(&space)
        .expect("seed — every next_slugs is NULL, exactly as a fresh install has it");

    assert!(
        reachable(&db, &space, "backlog", "done"),
        "backlog → research → approved → doing → done is the fallback CHAIN, so \
         `done` is reachable from `backlog` on an untouched board (D15)"
    );
    assert!(
        reachable(&db, &space, "backlog", "research"),
        "the immediate fallback neighbour too"
    );
    assert!(
        !reachable(&db, &space, "done", "backlog"),
        "and the fallback is directional like the column it stands in for"
    );
}

/// (D15's other half) a `NULL` origin on the LAST column has no `sort_order + 1`
/// neighbour, so the fallback resolves nothing and NOTHING is reachable.
///
/// This is the same answer `nextStepSlugs` gives — an empty array, "no next step"
/// — and the reason the fallback cannot be widened to `> sort_order`: that would
/// invent an edge for the last column and disagree with the board's own wires.
#[test]
fn forward_reachable_reaches_nothing_from_the_last_column_of_a_null_board() {
    let (_dir, db, space) = seeded("edges-null-last");
    db.get_board(&space).expect("seed");

    for target in ["backlog", "research", "approved", "doing"] {
        assert!(
            !reachable(&db, &space, "done", target),
            "`done` is the last column and points nowhere — `{target}` is not \
             reachable from it, so nothing leaving `done` is forward",
        );
    }
}

/// (`[]` is a value, not a gap) an explicitly configured EMPTY graph reaches
/// nothing — the fallback must NOT fire, because `[]` is configured.
///
/// This is the `??`-and-not-`||` rule `nextStepSlugs` states in its own comment,
/// and ADR 0099's rule that `[]` and `NULL` are different states: collapsing them
/// is the silent-green shape that doc refuses twice.
#[test]
fn forward_reachable_reaches_nothing_from_an_explicitly_empty_graph() {
    let (_dir, db, space) = seeded("edges-empty-graph");
    db.get_board(&space).expect("seed");
    db.set_stage_next(&space, "backlog", &[], &[])
        .expect("an explicit no-edge graph");

    for target in ["research", "approved", "doing", "done"] {
        assert!(
            !reachable(&db, &space, "backlog", target),
            "`[]` means this column leads nowhere by choice — `{target}` is not \
             reachable, and the `sort_order + 1` fallback must not fire over a \
             configured value",
        );
    }
}

/// (D8's chosen case, pinned by name) an UNREACHABLE target further right on a
/// CONFIGURED board is NOT forward, therefore the model's move is ALLOWED.
///
/// Every column is configured here and the graph dead-ends before `done`, so
/// `done` sits four columns to the right with no path to it. A `sort_order`
/// comparison would refuse this and would ALSO refuse the branch move in
/// [`forward_reachable_follows_every_edge_of_a_branch_not_just_the_head`]; D8 chose
/// reachability precisely so the skip answer is "allowed" and the branch answer is
/// "forward".
///
/// EVERY row is configured on purpose, and it is the detail the plan's shorthand
/// (`backlog` set to `["ready"]`, nothing else) missed: the fallback is per row, so
/// a NULL tail would contribute its order neighbour and make `done` reachable after
/// all. See [`forward_reachable_mixes_a_configured_row_with_a_null_one`]. An
/// operator who draws a graph that stops short of `done` has therefore LEFT the
/// model a door to `done` — that is D8's answer, not an oversight in the walk.
#[test]
fn forward_reachable_is_false_for_an_unreachable_target_further_right_on_a_configured_board() {
    let (_dir, db, space) = seeded("edges-skip-hole");
    db.get_board(&space).expect("seed");
    db.set_stage_next(&space, "backlog", &["research".to_string()], &[None])
        .expect("backlog → research and NOTHING else");
    db.set_stage_next(&space, "research", &["approved".to_string()], &[None])
        .expect("research → approved");
    db.set_stage_next(&space, "approved", &["doing".to_string()], &[None])
        .expect("approved → doing");
    db.set_stage_next(&space, "doing", &[], &[])
        .expect("doing leads nowhere, so the graph never reaches `done`");

    assert!(
        !reachable(&db, &space, "backlog", "done"),
        "`done` is four columns to the right and unreachable, so the move is not \
         forward — this is the case D8 chose over `sort_order`"
    );
    assert!(
        reachable(&db, &space, "backlog", "research"),
        "and the configured edge itself is forward, so the two answers come from \
         the same walk and not from a positional guess"
    );
}

/// (the D15 limit, pinned as ALLOWED) a `NULL` board with a HOLE ahead of the
/// origin resolves no fallback edge, so the forward move is allowed.
///
/// `delete_stage` removes a column and `sort_order` is NOT compacted
/// (`stages.rs`'s relocation is a bulk `UPDATE tasks` and one `DELETE`, nothing
/// else), so after `approved` is gone `research` has no `sort_order + 1` neighbour
/// and the fallback contributes nothing.
///
/// This matches TypeScript EXACTLY — `nextStepSlugs` filters on
/// `sortOrder === from.sortOrder + 1` and finds the same nothing — so the two
/// implementations disagree with the board and agree with each other. DO NOT
/// "fix" it by widening the fallback to `> sort_order`: that diverges from
/// `nextStepSlugs` SILENTLY, and Rust and TS would then answer the same claim
/// differently while the decision is live in both. A person reaches the far side
/// of the hole in two drags, so the hole costs a human nothing.
#[test]
fn forward_reachable_resolves_nothing_across_a_hole_left_by_a_deleted_column() {
    let (_dir, db, space) = seeded("edges-hole");
    db.get_board(&space).expect("seed");
    // `approved` holds no cards and nothing points at it, so the delete is legal
    // and leaves `sort_order` 0, 1, 3, 4 — the hole.
    db.delete_stage(&space, "approved", None)
        .expect("delete the middle column");

    assert!(
        reachable(&db, &space, "backlog", "research"),
        "the step BEFORE the hole still has its fallback neighbour"
    );
    assert!(
        !reachable(&db, &space, "backlog", "doing"),
        "and the walk STOPS at the hole: `research` has no `sort_order + 1` row, \
         so `doing` is unreachable and the forward move is allowed (the same hole \
         `nextStepSlugs` has — see the doc)"
    );
}

/// (`sort_order` is NOT unique, and BOTH columns at a collided order contribute) a
/// `NULL` row whose fallback order holds TWO columns resolves both, exactly as
/// `nextStepSlugs` filters every match rather than taking one.
///
/// WHY THIS WAS PINNED NOWHERE. `forward_reachable` builds
/// `by_order: HashMap<i64, Vec<String>>` and the `Vec` is the whole point — the
/// primary key is `(space_path, slug)` and NOTHING bounds `sort_order` to be distinct,
/// so two rows can share one order, and a `HashMap<i64, String>` would have compiled,
/// passed every other test in this file, and silently dropped whichever column the
/// `HashMap` happened to visit second. `nextStepSlugs`
/// (`src/lib/workflowGraph.ts`) spells the rule as a `filter` over EVERY column whose
/// `sortOrder` matches, and the production comment at `edges.rs` claims that agreement
/// "by construction, not by luck" — a claim that was true of the type and unproven of
/// the behaviour until this case.
///
/// THE SHAPE IS REACHABLE, not hypothetical: `reorder_stages` writes a dense 0-based
/// index so the app itself never collides, but no UNIQUE constraint or index backs that
/// up, so a foreign writer (or a later verb that stops renumbering everything) can.
/// Written as raw SQL for exactly that reason — there is no verb that produces it, and
/// that absence is a fact about today's writers, not a promise about tomorrow's.
#[test]
fn forward_reachable_resolves_every_column_sharing_a_sort_order_and_not_just_one() {
    let (_dir, db, space) = seeded("edges-dup-order");
    db.get_board(&space).expect("seed the five columns");
    // A sixth column, then collide it with `approved` at sort_order 2. `create_stage`
    // joins at MAX + 1 = 5, so the collision needs the raw write either way.
    db.create_stage(&space, "review", "Review", None)
        .expect("create_stage");
    raw_execute(
        &db,
        "UPDATE stages SET sort_order = 2 WHERE space_path = ?1 AND slug = 'review'",
        &space,
    );

    // The premise, asserted and not assumed: a pin that quietly stopped colliding
    // would pass forever for the wrong reason.
    let at_two: Vec<String> = db
        .list_stages(&space)
        .expect("list_stages")
        .into_iter()
        .filter(|s| s.sort_order == 2)
        .map(|s| s.slug)
        .collect();
    assert_eq!(
        at_two,
        vec!["approved".to_string(), "review".to_string()],
        "the fixture must actually hold TWO columns at one `sort_order` \
         (board order, so the pair is deterministic)"
    );

    // `research` (sort_order 1) stays NULL, so its fallback is the order-2 set. Give
    // each of the two collided columns a DIFFERENT door, so each assertion below can
    // only be satisfied by the column it names — a reading that kept one and dropped
    // the other fails exactly one assertion and says which.
    db.set_stage_next(&space, "approved", &["doing".to_string()], &[None])
        .expect("approved → doing");
    db.set_stage_next(&space, "review", &["done".to_string()], &[None])
        .expect("review → done");
    // `doing` is a CONFIGURED dead end, and that is load-bearing for the third
    // assertion: left NULL it would fall back to its `sort_order + 1` neighbour `done`
    // and `research → done` would hold through `approved` alone, so the assertion
    // below would pass with the collision resolved OR dropped. Ending the `approved`
    // branch is what makes `done` reachable only THROUGH the second column.
    db.set_stage_next(&space, "doing", &[], &[])
        .expect("and the FIRST column's branch ends, so only `review` reaches `done`");

    assert!(
        reachable(&db, &space, "research", "approved"),
        "the FIRST column at the collided order contributes its edge"
    );
    assert!(
        reachable(&db, &space, "research", "review"),
        "and so does the SECOND — `nextStepSlugs` filters EVERY column whose \
         `sortOrder` matches, so dropping one here would make Rust answer a claim \
         TypeScript answers differently"
    );
    assert!(
        reachable(&db, &space, "research", "done"),
        "the walk traverses THROUGH the second column too, so the collision is \
         resolved for the whole walk and not just for the fallback's first hop \
         (`doing` is a configured `[]`, so this is only reachable via `review`)"
    );
}

/// (unknown `from`) a column this Space does not have has no edges, so nothing is
/// reachable. `move_task` refuses an unknown DESTINATION before it ever asks this
/// question, and an unknown ORIGIN is not reachable either — the answer is `false`,
/// not an error, because "no path" is what was asked.
#[test]
fn forward_reachable_is_false_for_an_unknown_origin() {
    let (_dir, db, space) = seeded("edges-unknown-from");
    db.get_board(&space).expect("seed");

    assert!(
        !reachable(&db, &space, "ghost", "done"),
        "an origin with no row contributes no edges"
    );
}

/// (unknown `to`) a destination no row names is not reachable — same shape, the
/// other end. `move_task` validates the destination first, so this is the BFS's
/// own contract rather than a case the gate can produce.
#[test]
fn forward_reachable_is_false_for_an_unknown_destination() {
    let (_dir, db, space) = seeded("edges-unknown-to");
    db.get_board(&space).expect("seed");

    assert!(
        !reachable(&db, &space, "backlog", "ghost"),
        "a slug no column holds is not reachable even when the fallback chain is \
         alive — the walk ends at `done` and never names `ghost`"
    );
}

/// (`from == to`) staying put is not a forward move, EVEN ON A CYCLE.
///
/// The cycle is configured on purpose: a plain BFS starting at `A` reaches `A`
/// again by going around, so the short-circuit is what answers here and the test
/// pins that the short-circuit exists. A move to the column a card is already in
/// must not be refused — `move_task`'s existing behaviour for it stands.
#[test]
fn forward_reachable_is_false_when_the_origin_is_the_destination() {
    let (_dir, db, space) = seeded("edges-self");
    db.get_board(&space).expect("seed");
    db.set_stage_next(&space, "backlog", &["research".to_string()], &[None])
        .expect("backlog → research");
    db.set_stage_next(&space, "research", &["backlog".to_string()], &[None])
        .expect("and back again, so the walk WOULD come home");

    assert!(
        !reachable(&db, &space, "backlog", "backlog"),
        "a round trip is not a forward move"
    );
    assert!(
        !reachable(&db, &space, "done", "done"),
        "and on a column with no edges at all, same answer"
    );
}

/// (a cell nothing reads as an edge) a `next_slugs` the lenient parser cannot
/// decode reads as UNCONFIGURED, so the fallback supplies the edge — the same
/// reading [`lenient_next_slugs`] documents and the same one `nextStepSlugs`
/// receives over the wire, where an unparseable cell arrives as absent.
///
/// The alternative — treating it as `[]` — would make a foreign writer's garbage
/// CLOSE a door the board itself is drawing open, which is the opposite of the
/// safe reading `lenient_next_slugs` argues for.
#[test]
fn forward_reachable_reads_an_unparseable_cell_as_unconfigured_and_falls_back() {
    let (_dir, db, space) = seeded("edges-garbage");
    db.get_board(&space).expect("seed");
    // A JSON OBJECT, not an array: `serde_json::from_str::<Vec<String>>` fails on
    // it, so the cell decodes to `None` = unconfigured. Written as raw SQL because
    // `set_stage_next` validates and would refuse it.
    raw_execute(
        &db,
        "UPDATE stages SET next_slugs = '{\"not\":\"an array\"}' \
         WHERE space_path = ?1 AND slug = 'backlog'",
        &space,
    );

    assert!(
        reachable(&db, &space, "backlog", "research"),
        "a cell that decodes to nothing is UNCONFIGURED, so the `sort_order + 1` \
         neighbour is the edge — not an empty graph"
    );
}
