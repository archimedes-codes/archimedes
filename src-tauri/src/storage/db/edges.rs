//! The **edge graph** subject of `db`: the one question a card's move asks about
//! `stages.next_slugs` — can a card get from column `from` to column `to` by
//! following the arrows?
//!
//! ONE function, and it answers a graph question rather than a write. It exists
//! because ADR 0099's Strict gate and the forward gate ask DIFFERENT questions of
//! the same column:
//!
//! - Strict asks *"is `to` one of the FROM row's declared edges?"* — and a `NULL`
//!   row is unconstrained, so it passes (ADR 0099; the opposite reading makes every
//!   existing board that opts in refuse every drag).
//! - This asks *"does a path of edges lead to `to`?"* — and a `NULL` row still has
//!   a shape, because the column order implies a chain (D15), so it contributes the
//!   `sort_order + 1` neighbour.
//!
//! Those two `NULL` readings are not in tension and must not be collapsed into one
//! helper: one is "nothing is declared, so nothing is forbidden", the other is
//! "nothing is declared, but the board still has a next step". `move_task` runs
//! both, in that order, and pins both answers side by side.
//!
//! # Why the walk is in Rust and not in SQL
//!
//! `delete_stage` argues this for the same column (`stages.rs`, Refusal 2), and its
//! sentence is carried here with ONE word changed — that file refuses to *block a
//! delete*, this one refuses to *block the move*: the candidates come back as raw JSON
//! and the match happens through the SAME lenient parser the reader uses, *rather than
//! via `json_each`: a cell SQLite cannot parse would error inside the SQL, and a cell
//! this file reads as "unconfigured" must not be able to* block *the move — it
//! cannot be pointing anywhere, because nothing reads it as an edge.* A gate that
//! answered `Sqlite` where the board answers "unconfigured" would turn a foreign
//! writer's garbage into a refusal, which is the fail-closed twin of the
//! silently-shrunk workflow ADR 0099 refuses. Same argument, same column, one verb
//! swapped — which is why it is borrowed rather than re-derived.
//!
//! # Why it takes `&Connection` and not `Db::list_stages`
//!
//! Its only caller holds the connection guard. `list_stages` takes its own
//! `conn.lock()` and ADR 0119 §2 records that **the connection mutex is not
//! reentrant** — calling it while `move_task` holds the guard deadlocks rather than
//! reads, so the failure is a hung test and not an `Err`. This therefore follows the
//! `available_slugs` / `missing_stage` / `stage_slug_exists` shape in
//! [`super::stages`]: a `pub(super) fn` that borrows the caller's connection and
//! takes no lock of its own.
//!
//! # The `sort_order + 1` fallback (D15), and the hole it leaves
//!
//! `seed_default_stages` deliberately leaves `next_slugs` NULL, so an
//! unconfigured board is the NORMAL state, not the exception — a reachability test
//! over an empty edge set would refuse nothing on every Space the app itself
//! creates, which is exactly the dodge D8 was written to close. So a `NULL` row
//! contributes the column at `sort_order + 1`, and the default
//! backlog → research → approved → doing → done board answers the same way a
//! configured chain does.
//!
//! That is not a new opinion. It is the semantics `nextStepSlugs`
//! (`src/lib/workflowGraph.ts`) already implements and `nextStepOf` already
//! launches with, which is what makes Rust and TypeScript answer the same claim
//! identically while the decision is live in both places. Two consequences follow
//! and both are pinned by `db/tests/edges.rs` rather than argued here:
//!
//! - **`[]` is a value, not a gap.** A configured empty graph contributes NOTHING —
//!   the fallback does not fire over it. `nextStepSlugs` spells this `??` and not
//!   `||`, and ADR 0099's whole argument is that `[]` and `NULL` are different
//!   states.
//! - **A HOLE stops the walk.** `delete_stage` does not compact `sort_order`, so
//!   after a middle column is deleted the column before the hole has no
//!   `sort_order + 1` neighbour and the fallback resolves nothing. That is the same
//!   hole `nextStepSlugs` has, and it is deliberately NOT "fixed" by widening to
//!   `> sort_order` — that would diverge from the frontend silently and put the two
//!   implementations in disagreement about the same card. A person reaches the far
//!   side of a hole in two drags.

use std::collections::{HashMap, HashSet, VecDeque};

use rusqlite::{params, Connection};

use super::stages::lenient_next_slugs;
use super::BoardError;

/// Is `to` reachable from `from` by following this Space's `next_slugs` edges,
/// with the `sort_order + 1` fallback standing in for a row that is unconfigured?
///
/// `Ok(true)` means "a card in `from` can get to `to` by going forward", which is
/// what makes a move FORWARD and therefore what the model's door refuses (D7/D8).
///
/// The contract, edge by edge — each line is a test in `db/tests/edges.rs`:
///
/// - `from == to` is `Ok(false)` **before anything is read**. A cycle would bring
///   the walk home to its own start, and a round trip is not a forward move; a move
///   to the column a card is already in keeps the behaviour it has always had.
/// - An unknown `from` or an unknown `to` is `Ok(false)`. "No path" is the answer to
///   the question that was asked, not an error; `move_task` validates the
///   destination before it calls, so an unknown slug is this function's contract,
///   not a case the gate produces.
/// - A cycle terminates (the visited set) and classifies **both** directions as
///   forward, because on a cycle every edge points forward. Only a self-loop is
///   refused at the writer ([`BoardError::SelfLoop`]), so a two-column cycle is a
///   legal graph today and the walk must not hang on it.
/// - A cell the lenient parser cannot decode is UNCONFIGURED, so the fallback
///   supplies its edge — the safe reading [`lenient_next_slugs`] documents, and the
///   one the frontend gets too, since an unparseable cell arrives over the wire as
///   absent.
///
/// # The one read, and why it includes the origin's own row
///
/// ONE `SELECT` over the Space's `stages`, then a `VecDeque` frontier and a
/// `HashSet` visited set — the whole graph is a dozen rows at most, so the walk
/// costs less than the parse. Unlike `delete_stage`'s scan this one does **not**
/// filter the subject out: the origin's row is the walk's first hop, and dropping it
/// would make a configured `backlog → research` answer "not reachable".
pub(super) fn forward_reachable(
    conn: &Connection,
    space_path: &str,
    from: &str,
    to: &str,
) -> Result<bool, BoardError> {
    // The short-circuit, and it is load-bearing rather than an optimisation: the
    // walk below would answer `true` for a column that leads back to itself.
    if from == to {
        return Ok(false);
    }

    // Every row of this Space, once: `(slug, next_slugs, sort_order)`.
    // `next_slugs` comes back as the RAW cell and is decoded below through the
    // same lenient parser the board read uses — see the module doc for why that is
    // a correctness requirement and not a style choice.
    //
    // NO `ORDER BY`, and that is deliberate rather than an oversight worth "fixing".
    // The board read orders `sort_order ASC, slug ASC`; this one does not, because
    // nothing here reads the result in order — the two maps below are keyed lookups and
    // the BFS asks only set membership ("is `to` among this column's successors?"), so
    // SQLite's arbitrary row order cannot change an answer. The honest limit is worth
    // naming: `by_order`'s per-`sort_order` Vec therefore has an arbitrary element
    // ORDER. That is invisible to this function, but `nextStepOf` elsewhere DOES pick
    // the HEAD of its next-step list and so does depend on board order — so the rule
    // for a future editor is: if a caller ever starts reading a list built here
    // positionally, this query gains the board read's `ORDER BY sort_order ASC,
    // slug ASC` in the same change.
    let mut stmt =
        conn.prepare("SELECT slug, next_slugs, sort_order FROM stages WHERE space_path = ?1")?;
    let rows: Vec<(String, Option<String>, i64)> = stmt
        .query_map(params![space_path], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // `sort_order` → the slugs sitting at it, for the fallback's lookup.
    // A `Vec` and not a single slug because `sort_order` is NOT unique — the
    // primary key is `(space_path, slug)` and nothing else bounds it — and
    // `nextStepSlugs` filters EVERY column whose `sortOrder` matches rather than
    // taking one, so a duplicated order contributes every one of its rows here too.
    // That agreement is by construction, not by luck.
    let mut by_order: HashMap<i64, Vec<String>> = HashMap::new();
    for (slug, _, sort_order) in &rows {
        by_order.entry(*sort_order).or_default().push(slug.clone());
    }

    // `slug` → the columns it points at. One pass turns the rows into an owned map
    // so the walk below is pure traversal and never touches the connection again.
    let mut graph: HashMap<String, Vec<String>> = HashMap::with_capacity(rows.len());
    for (slug, raw, sort_order) in &rows {
        let successors = match lenient_next_slugs(raw.clone()) {
            // Configured — `Some(vec![])` included, which contributes nothing.
            Some(edges) => edges,
            // D15: unconfigured still has a next step, and it is the column at
            // `sort_order + 1` — which is NOTHING when a deleted column left a
            // hole there, and nothing at the board's right-hand end. Both are the
            // answers `nextStepSlugs` gives; see the module doc.
            None => by_order.get(&(sort_order + 1)).cloned().unwrap_or_default(),
        };
        graph.insert(slug.clone(), successors);
    }

    // The BFS. `from` is marked visited at the start, which is what makes the
    // `from == to` short-circuit above the ONLY thing that can answer "you are
    // already there" — the walk reports edges, and an edge into the start is a
    // cycle, not a destination.
    let mut visited: HashSet<String> = HashSet::new();
    visited.insert(from.to_string());
    let mut frontier: VecDeque<String> = VecDeque::new();
    frontier.push_back(from.to_string());

    while let Some(slug) = frontier.pop_front() {
        // A column the graph points at but does not hold (a dangling slug a foreign
        // writer left behind) contributes no successors: `graph.get` is `None`, and
        // a cell nothing reads as an edge cannot be pointing anywhere — the same
        // rule the module doc argues for an undecodable cell.
        for next in graph.get(&slug).map(Vec::as_slice).unwrap_or_default() {
            if next == to {
                return Ok(true);
            }
            if visited.insert(next.clone()) {
                frontier.push_back(next.clone());
            }
        }
    }
    Ok(false)
}
