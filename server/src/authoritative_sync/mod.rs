//! B0 — authoritative settlement bridge & operations-pull foundation.
//!
//! This module is the prerequisite for re-applying B1. It provides:
//! - **branch-isolated** newest-snapshot reconstruction from `sync_changelog`
//!   (every query keyed on `tenant_id + branch_id + table_name + record_id`);
//! - a small **operations-pull** over `operation_envelopes` by `server_sequence`
//!   so a client that does not know an `operationId` still receives every
//!   accepted operation for its own branch exactly once;
//! - (added after the write-path inventory) the schema-oriented legacy bridge and
//!   the atomic `sync_push` batch.
//!
//! Money is converted with [`lataif_server::money`] — never `f64 * 1000`.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

/// The newest non-deleted full-row snapshot for an exact, **branch-isolated**
/// record, or `None` if never synced for this branch or last action was delete.
/// Ordering is by the authoritative server changelog id only (never a client
/// timestamp); an older snapshot can never reappear after a delete.
pub fn latest_snapshot(
    conn: &Connection,
    tenant: &str,
    branch: &str,
    table: &str,
    record_id: &str,
) -> rusqlite::Result<Option<Value>> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT action, data FROM sync_changelog
             WHERE tenant_id = ?1 AND branch_id = ?2 AND table_name = ?3 AND record_id = ?4
             ORDER BY id DESC LIMIT 1",
            params![tenant, branch, table, record_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(match row {
        None => None,
        Some((action, _)) if action == "delete" => None,
        Some((_, data)) => serde_json::from_str::<Value>(&data).ok(),
    })
}

/// One authoritative operation envelope delivered by the pull.
#[derive(Debug, Clone)]
pub struct PulledOperation {
    pub server_sequence: i64,
    pub envelope: Value,
}

/// The result of an operations pull for one branch.
#[derive(Debug, Clone)]
pub struct PullResult {
    pub operations: Vec<PulledOperation>,
    pub cursor: i64,
    pub has_more: bool,
}

/// The clamped page size: at least 1, at most 1000.
fn clamp_limit(limit: i64) -> i64 {
    limit.clamp(1, 1000)
}

/// Pull accepted operation envelopes for `(tenant, branch)` with
/// `server_sequence > since`, ascending, at most `limit` **whole** envelopes
/// (an envelope is one row and is never split across pages). Returns the cursor
/// (the last delivered sequence, or `since` when empty) and `has_more`.
pub fn pull_operations(
    conn: &Connection,
    tenant: &str,
    branch: &str,
    since: i64,
    limit: i64,
) -> rusqlite::Result<PullResult> {
    let lim = clamp_limit(limit);
    let mut stmt = conn.prepare(
        "SELECT server_sequence, envelope_json FROM operation_envelopes
         WHERE tenant_id = ?1 AND branch_id = ?2 AND server_sequence > ?3
         ORDER BY server_sequence ASC LIMIT ?4",
    )?;
    let rows = stmt.query_map(params![tenant, branch, since, lim], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut operations = Vec::new();
    for row in rows {
        let (server_sequence, env_json) = row?;
        operations.push(PulledOperation {
            server_sequence,
            envelope: serde_json::from_str(&env_json).unwrap_or(Value::Null),
        });
    }
    let cursor = operations
        .last()
        .map(|o| o.server_sequence)
        .unwrap_or(since);
    // `has_more` only if the page was full AND another envelope exists beyond it.
    let has_more = if operations.len() as i64 == lim {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM operation_envelopes
                 WHERE tenant_id = ?1 AND branch_id = ?2 AND server_sequence > ?3)",
            params![tenant, branch, cursor],
            |r| r.get::<_, i64>(0),
        )? != 0
    } else {
        false
    };
    Ok(PullResult {
        operations,
        cursor,
        has_more,
    })
}

/// Render a [`PullResult`] as the pull endpoint's JSON body. `serverSequence`
/// and `cursor` are i64 decimal strings (protocol v4 wire convention).
pub fn pull_result_json(result: &PullResult) -> Value {
    serde_json::json!({
        "operations": result.operations.iter().map(|o| serde_json::json!({
            "serverSequence": o.server_sequence.to_string(),
            "envelope": o.envelope,
        })).collect::<Vec<_>>(),
        "cursor": result.cursor.to_string(),
        "hasMore": result.has_more,
    })
}

/// The adopted `(record_revision, data_json)` projection for a record, if it has
/// been cut over into `canonical_records` (and is therefore server-authoritative).
pub fn canonical_projection(
    conn: &Connection,
    tenant: &str,
    branch: &str,
    table: &str,
    record_id: &str,
) -> Option<(i64, Value)> {
    conn.query_row(
        "SELECT record_revision, data_json FROM canonical_records
         WHERE tenant_id=?1 AND branch_id=?2 AND table_name=?3 AND record_id=?4 AND deleted=0",
        params![tenant, branch, table, record_id],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
    )
    .optional()
    .ok()
    .flatten()
    .and_then(|(rev, d)| serde_json::from_str::<Value>(&d).ok().map(|v| (rev, v)))
}

pub mod bridge;

#[cfg(test)]
mod tests;
