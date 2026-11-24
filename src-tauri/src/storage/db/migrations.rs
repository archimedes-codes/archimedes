//! The **migration data steps** of `db`: the one-time backfill and the two
//! one-time seeds, lifted verbatim out of the unit that was `storage/db.rs`
//! (ADR 0113).
//!
//! ⚠️ These three free functions are called from inside `Db::open`'s `gate`
//! closures, which STAY in [`super`] — `gate` is the transaction factory that
//! makes an `ALTER` and its data step one atomic unit. Moving the data steps here
//! moves no gate: all thirteen `gate(&mut conn, …)` calls are inside `open`, and
//! `backfill_predicate_names_both_literals_and_renames_nothing` pins that this
//! file's own body carries the dual literal match it names.

use rusqlite::{params, Connection};

use super::{DbError, LAST_ACTIVITY};

/// One-time backfill of `sessions.todos_json` from the newest non-read
/// checklist write in `messages` (ADR 0073).
///
/// THE MATCH IS DUAL AND STAYS THAT WAY: `manage_todo_list` OR
/// `manage_checklist`. fulcrum#20 renames the tool, and the rows this reads are
/// ALREADY WRITTEN in users' databases and are never rewritten — so a predicate
/// naming one spelling silently backfills nothing for every row written under the
/// other. ADR 0093 freezes the old name for exactly this reason; the widen adds a
/// second literal and renames NOTHING (neither the tool, nor `todos_update` /
/// `todos_clear`, nor the `todos_json` column). The release ORDER is the load-
/// bearing part: this must ship BEFORE the tag bump that carries the rename, or
/// existing installs upgrade to an empty Checklist with a green suite.
pub(super) fn backfill_session_todos(conn: &Connection) -> Result<(), DbError> {
    let mut session_stmt = conn.prepare("SELECT id FROM sessions WHERE is_subagent = 0")?;
    let session_ids = session_stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(session_stmt);

    for session_id in session_ids {
        let matching_todos = {
            let mut msg_stmt = conn.prepare(
                "SELECT payload_json FROM messages \
                 WHERE session_id = ?1 AND kind = 'tool-call' \
                 AND (payload_json LIKE '%manage_todo_list%' OR payload_json LIKE '%manage_checklist%') \
                 ORDER BY id DESC",
            )?;
            let rows = msg_stmt.query_map(params![session_id], |row| row.get::<_, String>(0))?;
            let mut matched = None;

            for payload_res in rows {
                let payload_str = payload_res?;
                let Ok(val) = serde_json::from_str::<serde_json::Value>(&payload_str) else {
                    continue;
                };
                // DUAL MATCH, permanently (fulcrum#20 / ADR 0093): the tool is
                // being renamed `manage_todo_list` → `manage_checklist`, and rows
                // under BOTH spellings exist in the wild and are never rewritten.
                // Dropping the old literal here would make every pre-rename
                // install backfill nothing — an empty Checklist, a green suite, no
                // error. This widening must RELEASE BEFORE the tag bump that
                // carries the rename, and it stays forever after.
                if !matches!(
                    val.get("title").and_then(serde_json::Value::as_str),
                    Some("manage_todo_list") | Some("manage_checklist")
                ) {
                    continue;
                }
                let Some(raw_input) = val.get("rawInput") else {
                    continue;
                };
                if raw_input
                    .get("operation")
                    .and_then(serde_json::Value::as_str)
                    == Some("read")
                {
                    continue;
                }
                let Some(todo_list) = raw_input
                    .get("todoList")
                    .and_then(serde_json::Value::as_array)
                else {
                    continue;
                };

                let mut filtered = Vec::new();
                for item in todo_list {
                    let Some(content) = item.get("content").and_then(serde_json::Value::as_str)
                    else {
                        continue;
                    };
                    let Some(status) = item.get("status").and_then(serde_json::Value::as_str)
                    else {
                        continue;
                    };
                    // Drop items with empty content or status (slightly stricter than the old frontend filter).
                    if content.is_empty() || status.is_empty() {
                        continue;
                    }
                    let mut clean_item = serde_json::Map::new();
                    clean_item.insert(
                        "content".into(),
                        serde_json::Value::String(content.to_string()),
                    );
                    clean_item.insert(
                        "status".into(),
                        serde_json::Value::String(status.to_string()),
                    );
                    if let Some(desc) = item.get("description").and_then(serde_json::Value::as_str)
                    {
                        clean_item.insert(
                            "description".into(),
                            serde_json::Value::String(desc.to_string()),
                        );
                    }
                    filtered.push(serde_json::Value::Object(clean_item));
                }

                if !filtered.is_empty() {
                    matched = Some(serde_json::to_string(&filtered)?);
                    break;
                }
            }
            matched
        };

        if let Some(serialized) = matching_todos {
            conn.execute(
                "UPDATE sessions SET todos_json = ?2 WHERE id = ?1",
                params![session_id, serialized],
            )?;
        }
    }
    Ok(())
}

/// One-time seed of `spaces.sort_order` on a pre-existing database (ADR 0075).
///
/// The read order is the OLD display order (`last_opened_at DESC, path ASC`)
/// and is HARDCODED on purpose: at seed time every row still carries
/// `DEFAULT 0`, so ordering by `sort_order` would be a pure tie and would pick
/// an order nobody ever saw — the upgrade must reproduce the list the user was
/// already looking at (ADR 0075's Consequences own the full reason).
pub(super) fn seed_space_sort_order(conn: &Connection) -> Result<(), DbError> {
    let mut stmt =
        conn.prepare("SELECT path FROM spaces ORDER BY last_opened_at DESC, path ASC")?;
    let paths = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    // Close the read cursor before the writes start (the `backfill_session_todos`
    // hygiene — a live Statement is not a compile or SQLite requirement).
    drop(stmt);

    for (index, path) in paths.iter().enumerate() {
        conn.execute(
            "UPDATE spaces SET sort_order = ?2 WHERE path = ?1",
            params![path, index as i64],
        )?;
    }
    Ok(())
}

/// One-time seed of `sessions.sort_order` on a pre-existing database (ADR 0075).
///
/// The read order is the OLD display order (last activity, then `id DESC`) and
/// is HARDCODED on purpose for the same reason as `seed_space_sort_order`: at
/// seed time the column is all `DEFAULT 0`, so it cannot be its own seed order.
///
/// NO `WHERE` — every row is numbered, hidden `is_subagent = 1` rows included
/// (hazard H1): the bottom-join `MAX + 1` is global, so a hidden row already
/// consumes a number, and seeding only the visible rows would duplicate values
/// and tie them with the visible row at 0.
pub(super) fn seed_session_sort_order(conn: &Connection) -> Result<(), DbError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT id FROM sessions ORDER BY {LAST_ACTIVITY} DESC, id DESC"
    ))?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt); // close the read cursor before the writes (hygiene, as above)

    for (index, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE sessions SET sort_order = ?2 WHERE id = ?1",
            params![id, index as i64],
        )?;
    }
    Ok(())
}
