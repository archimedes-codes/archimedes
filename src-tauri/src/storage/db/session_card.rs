//! The **session→card read** of `db`: which card a Session owns, which Space that
//! card lives in, which column the Session was launched against, and the `rowid` of
//! the link row that said so.
//!
//! ONE question, one file, and the reason it is not a method in [`super::board`]
//! beside `Db::task_numbers` is that this answers it for ONE Session at a time and
//! returns four fields instead of three. `task_numbers` is the app-wide badge read —
//! one round trip at boot, one row per Session, everything the sidebar needs — and
//! the auto-advance decision needs the opposite shape: a single Session resolved at
//! the instant it claims, without fetching the whole app's link table to do it.
//!
//! # Why this read exists at all (D16)
//!
//! `mark_done`'s executor is `mark_done(db, origin, is_subagent, params)`. It holds
//! a Session id and nothing else — no `space_path`, no `task_id`, no launching
//! column, no cost figure. Everything the advance decision needs lives in the
//! database, so somebody has to resolve card, Space and frozen column from that one
//! id, and the read that does it belongs to `db` because only `db` can.
//!
//! # The newest link wins, and the rule is COPIED and not invented
//!
//! 31 of 104 live cards hold more than one linked Session, and a Session is handed
//! between cards, so "which card does this Session own" is genuinely ambiguous and
//! cannot be left to whichever row SQLite reaches first. [`Db::task_numbers`] answers
//! the same question for the badge with
//! `WHERE ts.rowid = (SELECT MAX(ts2.rowid) … WHERE ts2.session_id = ts.session_id)`
//! — newest link wins — and this read spells the SAME correlated subquery. That is
//! not a duplication to be proud of; it is the point. Two reads that answer one
//! question with two rules is how a card ends up wearing a badge on one card while
//! its chain is bounded against another's Space, and the pair is pinned against
//! exactly that by
//! `card_of_session_and_task_numbers_agree_on_which_card_a_session_wears`.
//!
//! The consequence of choosing newest is stated rather than discovered: when the
//! newest link's card sits in a DIFFERENT Space from an older link's, the newest
//! link's Space is the Space. "The most recent card this Session was launched
//! against" is the only question a Session can answer about a card it does not own —
//! the words `task_numbers`' own doc uses for its own frozen lane — and a Space is
//! whatever that card's row says it is.
//!
//! # Why `own_link_rowid` is part of the answer
//!
//! The dedupe the advice runs (D17) asks "has this link already launched?", and it
//! asks it as `rowid > <the claimer's own link rowid>`. That bound is
//! **Session-scoped** — the claimer's own row — while the row it searches for is
//! **card-scoped**, because the launch a successful advance records links the
//! *newly started* Session and not the claimer. Recomputing the bound inside the
//! advice invites collapsing those two scopes into one, and a one-scope reading makes
//! the arm silently dead: since the newest-link rule makes the claimer's row the
//! newest *for that Session*, a Session-scoped search can never satisfy `rowid > own`.
//! So the read that already resolved the winner returns its `rowid`, and there is
//! exactly one place the bound comes from.
//!
//! # The `&Connection` shape is not optional
//!
//! [`card_of_session_on`] takes a connection the caller already holds, and the
//! advice calls it from inside its own guard. `Db::conn` is a `StdMutex<Connection>`
//! and **the mutex is not reentrant** — ADR 0119 §2: *"the connection mutex is not
//! reentrant, so a verb that called the public one while holding the guard would
//! deadlock rather read"*. The failure is a hung test binary, not an `Err`. So the
//! read lives on `&Connection` and the `&self` wrapper is the one line that takes the
//! lock — the `auto_guards` / [`Db::auto_guards_on`] pair, which is the in-repo
//! precedent for exactly this split and whose doc states the same reason.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::{BoardError, Db};

/// What one Session owns: the card, its Space, the column the link froze, and the
/// link row's own `rowid`.
///
/// NOT in [`super::rows`], and that follows that module's own rule: every struct
/// there has ONE `*_COLUMNS` const, ONE positional `get` ladder and a compile-time
/// arity tie, because the registry exists to keep a shared SELECT list from being
/// edited apart from its mapper. This read has ONE statement and ONE consumer, and
/// its projection is a join whose terms are table-qualified (`ts.`, `t.`) — so a
/// `join(", ")` of bare column names cannot produce it, which is the same reason
/// `TASK_NUMBER_COLUMNS` carries only an arity tie and its statement spells itself.
/// A struct in `rows` without a column list would be the registry's one exception
/// and the drift guards would quietly stop covering it; `WorkflowRunRow` living in
/// [`super::workflow_runs`] is the in-repo precedent for a single-projection row type
/// staying beside its one read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardOfSession {
    /// The card the newest link names.
    pub task_id: String,
    /// The Space that card lives in — read from the CARD's row, never from the
    /// link's, because a hand-off across Spaces moves the Space with the card.
    pub space_path: String,
    /// The FROZEN lane: `task_sessions.stage_slug`, the column this Session was
    /// launched against. Nullable because the column is, and the advice treats a
    /// `None` as "no launching column is known", not as "the first column".
    pub launched_slug: Option<String>,
    /// The `rowid` of the winning link row — the lower bound of the D17 dedupe, and
    /// the reason it cannot be recomputed in the wrong scope.
    pub own_link_rowid: i64,
}

impl Db {
    /// Which card one Session owns — the `&self` wrapper that takes the lock.
    ///
    /// For callers OUTSIDE a lock. A verb that already holds the connection guard
    /// must call [`Db::card_of_session_on`] instead; calling this one from inside
    /// that guard is a self-deadlock on a non-reentrant mutex, and it hangs rather
    /// than failing.
    pub fn card_of_session(&self, session_id: &str) -> Result<Option<CardOfSession>, BoardError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        card_of_session_on(&guard, session_id)
    }
}

/// Which card one Session owns, read on a connection the caller already holds.
///
/// The read half of [`Db::card_of_session`]'s contract, spelled on `&Connection` so
/// a verb that is mid-lock can use it. Visibility is the widened-but-not-`pub` one
/// and taking `&Connection` rather than `&self` is the whole point — the same middle
/// visibility [`Db::auto_guards_on`] documents: a sibling may not read a sibling's
/// private item, and the advice holds the one lock this read has to ride.
///
/// `Ok(None)` is the answer to "no card", and it covers both shapes that mean it: a
/// Session that was never linked, and a Session whose newest link names a card that
/// is gone. The `INNER JOIN` on `tasks` is what makes the second one absence rather
/// than a row built on a missing card — `task_sessions` carries no foreign key on
/// `task_id` (ADR 0090), so SQLite will not reject the dangling link and only the
/// join can notice it. `task_numbers` makes the same choice for the same reason.
///
/// ONE statement, no lock of its own, no write.
pub(super) fn card_of_session_on(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<CardOfSession>, BoardError> {
    // The winner is chosen BEFORE the join, in the subquery, which is the whole of
    // the newest-link rule: a Session whose NEWEST link cannot resolve gets no card,
    // not its older link's. Falling back to the newest RESOLVING link would put a
    // card on a Session that no longer wears one — `task_numbers` refuses that in its
    // own doc, and the two reads must not disagree about it.
    //
    // Every term is table-qualified and the projection is spelled inline for the
    // reason `CardOfSession`'s doc gives: this is a three-table read (`ts`, `t`, and
    // the `ts2` subquery) and a `join(", ")` of unqualified names cannot produce it.
    let mut stmt = conn.prepare(
        "SELECT ts.task_id, t.space_path, ts.stage_slug, ts.rowid \
         FROM task_sessions AS ts \
         JOIN tasks AS t ON t.id = ts.task_id \
         WHERE ts.session_id = ?1 \
           AND ts.rowid = (SELECT MAX(ts2.rowid) FROM task_sessions AS ts2 \
                           WHERE ts2.session_id = ts.session_id)",
    )?;
    let row = stmt.query_row(rusqlite::params![session_id], |row| {
        Ok(CardOfSession {
            task_id: row.get::<_, String>(0)?,
            space_path: row.get::<_, String>(1)?,
            launched_slug: row.get::<_, Option<String>>(2)?,
            own_link_rowid: row.get::<_, i64>(3)?,
        })
    });
    match row {
        Ok(card) => Ok(Some(card)),
        // Matched EXPLICITLY rather than folding a mapper failure into `None` — the
        // `auto_guards_on` / `session_cost` precedent, and the reason is the same
        // one those two give: once the mapper can error, `query(..).next()` makes
        // "row present but unreadable" indistinguishable from "no such row", and the
        // advice reads this `None` as "this Session owns no card" and says so out
        // loud to the model.
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}
