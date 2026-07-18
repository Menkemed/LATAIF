//! M6-B3B1 — the server-authoritative compare-and-swap (CAS) engine. **INACTIVE.**
//!
//! This module implements the v4 write path's core: a monotone, server-authoritative entity
//! revision model with real `base_revision` CAS, `operation_id` idempotency, a canonical conflict
//! envelope and safe tombstone semantics. It is reachable ONLY from an internal Rust call
//! (`apply_operations`) and its tests. NOTHING here is wired to `/api/sync/push`, `/api/sync/pull`,
//! the legacy desktop or mobile push, the SQL.js client apply path, or any cutover step. No route
//! consults it; `protocol_v4_write_path_ready` is never touched. Activating it is a later slice.
//!
//! ## Storage (migration v0010, see migrations.rs)
//! - `canonical_entities` — one row per (tenant, branch, table, record) with the authoritative
//!   `current_revision`, `canonical_data`, `is_tombstone`, `last_operation_id`, `canonical_hash`.
//! - `operation_ledger` — one row per `operation_id` (globally unique) recording the frozen outcome
//!   (`applied` or `conflict`) so a replay returns the exact original result and never mutates twice.
//! The v0001 `canonical_records` / `operations` tables are left untouched (see the v0010 doc for why
//! they could not be safely extended).
//!
//! ## Contract
//! Every operation first passes the B3A schema SSOT (`sync_schema::change_contract_violation` —
//! identifier / control-plane / table allowlist / operation allowlist / field allowlist / payload
//! shape / size / duplicate keys). Revisions are server-assigned and strictly monotone: insert → 1,
//! each successful update/delete → current+1. A delete writes a tombstone (the row stays, the flag
//! flips); nothing here physically deletes or purges. CAS: an insert applies iff the entity is
//! absent and `base_revision == 0`; an update/delete applies iff the entity is present, not a
//! tombstone, and `base_revision == current_revision`; otherwise `SYNC_REVISION_CONFLICT` with no
//! mutation. Idempotency: a repeated `operation_id` with the same canonical request hash replays the
//! stored result; with a different hash it is `SYNC_OPERATION_ID_REUSE` with no mutation.

// INACTIVE by design: the public API is exercised by this module's tests now and will be consumed
// by the route integration in a later slice (B3B2). Until a production caller exists, the plain lib
// build (cfg(test) off) sees no internal user of these items — `mod sync` is private, so nothing
// here is crate-public API the lint would consider used. Silence dead-code for the whole cohesive
// inactive module rather than sprinkling per-item allows.
#![allow(dead_code)]

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::sync_schema;

/// A CAS conflict: the requested `base_revision` does not match the authoritative state.
pub const ERR_REVISION_CONFLICT: &str = "SYNC_REVISION_CONFLICT";
/// A known `operation_id` was re-submitted with a DIFFERENT canonical request — an idempotency-key
/// misuse. No mutation; distinct from a revision conflict.
pub const ERR_OPERATION_ID_REUSE: &str = "SYNC_OPERATION_ID_REUSE";
/// A batch that repeats one `operation_id` with two DIFFERENT requests — rejected in preflight
/// before any processing (an identical repeat is allowed and deterministically replays).
pub const ERR_DUPLICATE_OPERATION_ID_IN_BATCH: &str = "SYNC_DUPLICATE_OPERATION_ID_IN_BATCH";
/// The v4 protocol version stamped into the request hash so a v4 op can never collide with any other
/// protocol's hash of the same fields.
pub const PROTOCOL_VERSION_V4: i64 = 4;
/// A principal id was empty, over-long, or carried a control character.
pub const ERR_PRINCIPAL_INVALID: &str = "SYNC_PRINCIPAL_INVALID";
/// A generous upper bound on a principal id (a UUID / hostname / device fingerprint is far shorter);
/// it exists only to refuse an unbounded string, never to constrain a legitimate id.
pub const MAX_PRINCIPAL_ID_LEN: usize = 200;

/// A TYPED, already-authenticated principal. The route verifies the JWT / device certificate and
/// CLASSIFIES the caller before the engine sees it; the engine only records this and folds it into
/// the request hash. Crucially:
/// - a `Device` is NOT an artificial `users` row (several devices may belong to one user);
/// - a `System` principal is not a device;
/// - the same id STRING under two different variants (`User{"x"}` vs `Device{"x"}`) is two DIFFERENT
///   principals, because the variant becomes `principal_type` in both storage and the request hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CasPrincipal {
    User { user_id: String },
    Device { device_id: String },
    System { principal_id: String },
}

impl CasPrincipal {
    /// The stored `principal_type` discriminator (`user` / `device` / `system`).
    pub fn kind(&self) -> &'static str {
        match self {
            CasPrincipal::User { .. } => "user",
            CasPrincipal::Device { .. } => "device",
            CasPrincipal::System { .. } => "system",
        }
    }
    /// The opaque principal id — NOT resolved against `users` (a device/system principal has none).
    pub fn id(&self) -> &str {
        match self {
            CasPrincipal::User { user_id } => user_id,
            CasPrincipal::Device { device_id } => device_id,
            CasPrincipal::System { principal_id } => principal_id,
        }
    }
    /// Non-empty, within the length bound, no control characters (a control byte in an id that is
    /// stored and later echoed is an injection vector).
    fn validate(&self) -> Result<(), &'static str> {
        let id = self.id();
        if id.is_empty() || id.len() > MAX_PRINCIPAL_ID_LEN || id.chars().any(|c| c.is_control()) {
            return Err(ERR_PRINCIPAL_INVALID);
        }
        Ok(())
    }
}

/// The three mutations the CAS engine understands. Deliberately a closed set — the B3A operation
/// allowlist decides which are permitted per table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Insert,
    Update,
    Delete,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Action::Insert => "insert",
            Action::Update => "update",
            Action::Delete => "delete",
        }
    }
}

/// One v4 operation to attempt. `payload` is the record's business data as a JSON object string for
/// insert/update; for delete it is ignored for storage but still folded into the request hash.
#[derive(Debug, Clone)]
pub struct OperationInput {
    pub operation_id: String,
    pub tenant_id: String,
    pub branch_id: String,
    /// The typed, already-authenticated caller (M6-B3B1A). Not a users id string.
    pub principal: CasPrincipal,
    pub table_name: String,
    pub record_id: String,
    pub action: Action,
    pub base_revision: i64,
    pub payload: String,
}

/// The per-operation outcome. `Applied`/`Conflict` are the two stored outcomes; `IdempotentReplay`
/// is returned when a stored operation is replayed with an identical request; `OperationIdReuse`
/// when the same id arrives with a different request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpStatus {
    Applied,
    Conflict,
    IdempotentReplay,
    OperationIdReuse,
}

/// The canonical conflict/result envelope. Serialized verbatim into `operation_ledger.result_json`
/// so a replay returns the exact original bytes. On replay the caller-facing `status` becomes
/// `IdempotentReplay` while every other field is the frozen original.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpResult {
    pub operation_id: String,
    pub status: OpStatus,
    /// `SYNC_REVISION_CONFLICT` / `SYNC_OPERATION_ID_REUSE` / none.
    pub code: Option<String>,
    pub tenant_id: String,
    pub branch_id: String,
    pub table_name: String,
    pub record_id: String,
    pub action: Action,
    pub requested_base_revision: i64,

    // ── applied ──
    pub applied_revision: Option<i64>,
    pub canonical_hash: Option<String>,
    pub is_tombstone: Option<bool>,

    // ── conflict: the authoritative current state (within the operation's own scope) ──
    pub current_revision: Option<i64>,
    pub current_is_tombstone: Option<bool>,
    pub current_canonical_hash: Option<String>,
    pub current_canonical_data: Option<String>,
}

/// A whole-batch failure. `Applied`/`Conflict`/reuse are per-operation results, NOT errors — a
/// conflict on entity A never blocks entity B. These three, by contrast, reject or roll back the
/// entire batch with no operation stored.
#[derive(Debug)]
pub enum CasError {
    /// A B3A contract violation on op `index` (identifier / table / operation / field / payload).
    ValidationRejected { index: usize, code: &'static str },
    /// The batch repeats `operation_id` with two different requests (preflight).
    DuplicateOperationIdInBatch { operation_id: String },
    /// A transient database error — the whole transaction is rolled back.
    Db(rusqlite::Error),
}

impl CasError {
    pub fn code(&self) -> &'static str {
        match self {
            CasError::ValidationRejected { code, .. } => code,
            CasError::DuplicateOperationIdInBatch { .. } => ERR_DUPLICATE_OPERATION_ID_IN_BATCH,
            CasError::Db(_) => "SYNC_DB_ERROR",
        }
    }
}

// ── canonical hashing ────────────────────────────────────────────────────────

fn sha256_hex(s: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// A deterministic, key-order-independent serialization of a JSON value: objects are emitted with
/// their keys sorted, recursively. Two payloads that differ only in key order hash identically
/// (I8), and any difference in a bound field changes the hash (I5–I7). NOT a general canonical-JSON
/// standard — only a stable digest input for this engine.
fn canonical_json(v: &Value) -> String {
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let inner: Vec<String> = keys
                .iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        Value::String((*k).clone()),
                        canonical_json(&map[*k])
                    )
                })
                .collect();
            format!("{{{}}}", inner.join(","))
        }
        Value::Array(arr) => {
            format!(
                "[{}]",
                arr.iter().map(canonical_json).collect::<Vec<_>>().join(",")
            )
        }
        other => other.to_string(),
    }
}

/// The request hash binds every field an idempotency key must be unique over (§7): protocol,
/// tenant, branch, principal, table, record, action, base_revision, and the CANONICAL payload.
fn request_hash(op: &OperationInput) -> Result<String, &'static str> {
    let data: Value = if op.payload.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&op.payload).map_err(|_| sync_schema::ERR_PAYLOAD_INVALID)?
    };
    let req = serde_json::json!({
        "v": PROTOCOL_VERSION_V4,
        "tenant_id": op.tenant_id,
        "branch_id": op.branch_id,
        "principal_type": op.principal.kind(),
        "principal_id": op.principal.id(),
        "table_name": op.table_name,
        "record_id": op.record_id,
        "action": op.action.as_str(),
        "base_revision": op.base_revision,
        "data": data,
    });
    Ok(sha256_hex(&canonical_json(&req)))
}

/// The hash of an entity's canonical STATE — the (data, tombstone) pair. A tombstone therefore has a
/// different hash than the live record it replaced.
fn canonical_state_hash(canonical_data: &str, is_tombstone: bool) -> String {
    let data: Value = serde_json::from_str(canonical_data).unwrap_or(Value::Null);
    let state = serde_json::json!({ "data": data, "tombstone": is_tombstone });
    sha256_hex(&canonical_json(&state))
}

// ── the entity read + CAS decision ───────────────────────────────────────────

struct EntityState {
    current_revision: i64,
    canonical_data: String,
    is_tombstone: bool,
    canonical_hash: String,
}

fn load_entity(tx: &Transaction, op: &OperationInput) -> rusqlite::Result<Option<EntityState>> {
    tx.query_row(
        "SELECT current_revision, canonical_data, is_tombstone, canonical_hash
           FROM canonical_entities
          WHERE tenant_id = ?1 AND branch_id = ?2 AND table_name = ?3 AND record_id = ?4",
        params![op.tenant_id, op.branch_id, op.table_name, op.record_id],
        |r| {
            Ok(EntityState {
                current_revision: r.get(0)?,
                canonical_data: r.get(1)?,
                is_tombstone: r.get::<_, i64>(2)? != 0,
                canonical_hash: r.get(3)?,
            })
        },
    )
    .optional()
}

enum Decision {
    Apply {
        new_revision: i64,
        new_data: String,
        new_tombstone: bool,
        new_hash: String,
    },
    Conflict,
}

/// The pure CAS verdict (§6). Server-authoritative: revisions come from `current`, never the client.
fn decide(op: &OperationInput, current: &Option<EntityState>) -> Decision {
    match op.action {
        // Insert: applies iff the entity is absent AND the client claims no prior revision (base 0).
        // An existing entity — live OR tombstoned — is a conflict (no silent resurrection).
        Action::Insert => {
            if current.is_none() && op.base_revision == 0 {
                Decision::Apply {
                    new_revision: 1,
                    new_data: op.payload.clone(),
                    new_tombstone: false,
                    new_hash: canonical_state_hash(&op.payload, false),
                }
            } else {
                Decision::Conflict
            }
        }
        // Update: applies iff present, not a tombstone, and base == current.
        Action::Update => match current {
            Some(e) if !e.is_tombstone && e.current_revision == op.base_revision => Decision::Apply {
                new_revision: e.current_revision + 1,
                new_data: op.payload.clone(),
                new_tombstone: false,
                new_hash: canonical_state_hash(&op.payload, false),
            },
            _ => Decision::Conflict,
        },
        // Delete: applies iff present, not already a tombstone, and base == current. The tombstone
        // keeps the last data (so what was deleted is remembered) and flips the flag.
        Action::Delete => match current {
            Some(e) if !e.is_tombstone && e.current_revision == op.base_revision => Decision::Apply {
                new_revision: e.current_revision + 1,
                new_data: e.canonical_data.clone(),
                new_tombstone: true,
                new_hash: canonical_state_hash(&e.canonical_data, true),
            },
            _ => Decision::Conflict,
        },
    }
}

// ── result envelope constructors ─────────────────────────────────────────────

impl OpResult {
    fn base(op: &OperationInput, status: OpStatus, code: Option<&str>) -> Self {
        OpResult {
            operation_id: op.operation_id.clone(),
            status,
            code: code.map(|s| s.to_string()),
            tenant_id: op.tenant_id.clone(),
            branch_id: op.branch_id.clone(),
            table_name: op.table_name.clone(),
            record_id: op.record_id.clone(),
            action: op.action,
            requested_base_revision: op.base_revision,
            applied_revision: None,
            canonical_hash: None,
            is_tombstone: None,
            current_revision: None,
            current_is_tombstone: None,
            current_canonical_hash: None,
            current_canonical_data: None,
        }
    }

    fn applied(op: &OperationInput, revision: i64, hash: &str, tombstone: bool) -> Self {
        let mut r = OpResult::base(op, OpStatus::Applied, None);
        r.applied_revision = Some(revision);
        r.canonical_hash = Some(hash.to_string());
        r.is_tombstone = Some(tombstone);
        r
    }

    fn conflict(op: &OperationInput, current: Option<&EntityState>) -> Self {
        let mut r = OpResult::base(op, OpStatus::Conflict, Some(ERR_REVISION_CONFLICT));
        if let Some(e) = current {
            r.current_revision = Some(e.current_revision);
            r.current_is_tombstone = Some(e.is_tombstone);
            r.current_canonical_hash = Some(e.canonical_hash.clone());
            r.current_canonical_data = Some(e.canonical_data.clone());
        }
        r
    }

    fn reuse(op: &OperationInput) -> Self {
        OpResult::base(op, OpStatus::OperationIdReuse, Some(ERR_OPERATION_ID_REUSE))
    }
}

// ── the engine ───────────────────────────────────────────────────────────────

/// Apply a batch of v4 operations. INTERNAL — not routed anywhere in this slice.
///
/// Preflight (whole batch, before any write): every op passes the B3A contract, and no
/// `operation_id` repeats within the batch with two different requests. A preflight failure rejects
/// the entire batch with nothing processed. Processing then runs the ops in input order inside ONE
/// immediate transaction, so a later op sees the revisions of earlier applied ops in the same batch,
/// a conflict on one entity does not block another, and any transient DB error rolls the whole batch
/// back (no partial ledger, no partial mutation).
pub fn apply_operations(
    conn: &mut Connection,
    now: &str,
    ops: &[OperationInput],
) -> Result<Vec<OpResult>, CasError> {
    // ── preflight §9 — B3A contract + per-op request hash ──
    let mut prepared: Vec<(&OperationInput, String)> = Vec::with_capacity(ops.len());
    for (i, op) in ops.iter().enumerate() {
        if let Some(code) =
            sync_schema::change_contract_violation(&op.table_name, op.action.as_str(), &op.payload)
        {
            return Err(CasError::ValidationRejected { index: i, code });
        }
        if let Err(code) = op.principal.validate() {
            return Err(CasError::ValidationRejected { index: i, code });
        }
        if op.base_revision < 0 {
            return Err(CasError::ValidationRejected {
                index: i,
                code: sync_schema::ERR_PAYLOAD_INVALID,
            });
        }
        let rh = request_hash(op).map_err(|code| CasError::ValidationRejected { index: i, code })?;
        prepared.push((op, rh));
    }
    // ── preflight §9 — duplicate operation_id within the batch ──
    // Identical repeats are allowed (they deterministically replay in processing); a repeat with a
    // DIFFERENT request is a client error and rejects the whole batch.
    {
        use std::collections::HashMap;
        let mut seen: HashMap<&str, &str> = HashMap::new();
        for (op, rh) in &prepared {
            match seen.get(op.operation_id.as_str()) {
                Some(prev) if *prev != rh.as_str() => {
                    return Err(CasError::DuplicateOperationIdInBatch {
                        operation_id: op.operation_id.clone(),
                    });
                }
                Some(_) => {}
                None => {
                    seen.insert(op.operation_id.as_str(), rh.as_str());
                }
            }
        }
    }

    // ── processing §9 — one immediate transaction; write lock up front so CAS is serialized ──
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(CasError::Db)?;
    let mut results = Vec::with_capacity(prepared.len());
    for (op, rh) in &prepared {
        let res = process_one(&tx, now, op, rh).map_err(CasError::Db)?;
        results.push(res);
    }
    tx.commit().map_err(CasError::Db)?;
    Ok(results)
}

fn process_one(
    tx: &Transaction,
    now: &str,
    op: &OperationInput,
    request_hash: &str,
) -> rusqlite::Result<OpResult> {
    // ── idempotency §7 — has this operation_id already been recorded? ──
    let existing: Option<(String, String)> = tx
        .query_row(
            "SELECT request_hash, result_json FROM operation_ledger WHERE operation_id = ?1",
            params![op.operation_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((stored_hash, stored_json)) = existing {
        if stored_hash == request_hash {
            // Identical request → replay the frozen result verbatim. No mutation, no new revision.
            let mut res: OpResult = serde_json::from_str(&stored_json)
                .expect("operation_ledger.result_json is engine-written and always valid");
            res.status = OpStatus::IdempotentReplay;
            return Ok(res);
        }
        // Same id, different request → reuse. No mutation. (The stored row is untouched.)
        return Ok(OpResult::reuse(op));
    }

    // ── CAS §6 — the write lock is held, so `current` is the authoritative state ──
    let current = load_entity(tx, op)?;
    match decide(op, &current) {
        Decision::Apply {
            new_revision,
            new_data,
            new_tombstone,
            new_hash,
        } => {
            if current.is_none() {
                // Insert — the entity is absent (decided under the write lock).
                tx.execute(
                    "INSERT INTO canonical_entities
                       (tenant_id, branch_id, table_name, record_id, current_revision,
                        canonical_data, is_tombstone, last_operation_id, canonical_hash,
                        created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                    params![
                        op.tenant_id,
                        op.branch_id,
                        op.table_name,
                        op.record_id,
                        new_revision,
                        new_data,
                        new_tombstone as i64,
                        op.operation_id,
                        new_hash,
                        now
                    ],
                )?;
            } else {
                // Update/delete — compare-and-swap at the SQL level: the UPDATE only matches while
                // the row is still at `base_revision` and not a tombstone. Under the immediate
                // transaction this always matches the row `decide` saw; the guard is defence in
                // depth against any weaker isolation.
                let rows = tx.execute(
                    "UPDATE canonical_entities
                        SET current_revision = ?1, canonical_data = ?2, is_tombstone = ?3,
                            last_operation_id = ?4, canonical_hash = ?5, updated_at = ?6
                      WHERE tenant_id = ?7 AND branch_id = ?8 AND table_name = ?9 AND record_id = ?10
                        AND current_revision = ?11 AND is_tombstone = 0",
                    params![
                        new_revision,
                        new_data,
                        new_tombstone as i64,
                        op.operation_id,
                        new_hash,
                        now,
                        op.tenant_id,
                        op.branch_id,
                        op.table_name,
                        op.record_id,
                        op.base_revision
                    ],
                )?;
                if rows != 1 {
                    // Would mean a concurrent write slipped past the immediate lock — impossible in
                    // practice, but never silently double-apply: fail the batch so it rolls back.
                    return Err(rusqlite::Error::StatementChangedRows(rows));
                }
            }
            let res = OpResult::applied(op, new_revision, &new_hash, new_tombstone);
            insert_ledger(tx, now, op, request_hash, "applied", Some(new_revision), &res)?;
            Ok(res)
        }
        Decision::Conflict => {
            let res = OpResult::conflict(op, current.as_ref());
            // The conflict is FROZEN in the ledger so a replay (§7 I4) returns this exact envelope,
            // even if the entity's revision advances afterwards. No canonical mutation.
            insert_ledger(tx, now, op, request_hash, "conflict", None, &res)?;
            Ok(res)
        }
    }
}

fn insert_ledger(
    tx: &Transaction,
    now: &str,
    op: &OperationInput,
    request_hash: &str,
    result_status: &str,
    applied_revision: Option<i64>,
    result: &OpResult,
) -> rusqlite::Result<()> {
    let result_json = serde_json::to_string(result).expect("OpResult always serializes");
    tx.execute(
        "INSERT INTO operation_ledger
           (operation_id, tenant_id, branch_id, principal_type, principal_id, table_name, record_id,
            action, base_revision, request_hash, result_status, applied_revision, result_json,
            created_at, completed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)",
        params![
            op.operation_id,
            op.tenant_id,
            op.branch_id,
            op.principal.kind(),
            op.principal.id(),
            op.table_name,
            op.record_id,
            op.action.as_str(),
            op.base_revision,
            request_hash,
            result_status,
            applied_revision,
            result_json,
            now
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lataif_server::migrations::run_migrations;
    use rusqlite::Connection;
    use std::time::Duration;

    const TENANT: &str = "tenant-1";
    const BRANCH: &str = "branch-main";
    const PRINCIPAL: &str = "user-owner";
    const NOW: &str = "2026-07-18T00:00:00Z";
    const P1: &str = r#"{"brand":"X","name":"Y"}"#;
    const P2: &str = r#"{"brand":"Z","name":"Y"}"#;

    /// The minimal pre-existing embedded schema (tenants/branches/users/…) the migrations land on,
    /// seeded so the CAS tables' FKs resolve. Mirrors `db.rs` / `migrations::tests::base_db`, plus a
    /// second tenant and a second branch so scope-isolation (C9/C10) has somewhere to go.
    fn base_schema(conn: &Connection) {
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute_batch(
            "CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
                name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
                email TEXT NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(tenant_id, email));
             CREATE TABLE user_branches (user_id TEXT NOT NULL REFERENCES users(id),
                branch_id TEXT NOT NULL REFERENCES branches(id), role TEXT NOT NULL DEFAULT 'viewer',
                is_default INTEGER DEFAULT 0, created_at TEXT NOT NULL, PRIMARY KEY (user_id, branch_id));
             CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
                branch_id TEXT NOT NULL, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
                action TEXT NOT NULL, data TEXT NOT NULL, user_id TEXT, created_at TEXT NOT NULL);
             INSERT INTO tenants (id, name, slug, created_at, updated_at)
                VALUES ('tenant-1','T','t','n','n'), ('tenant-2','T2','t2','n','n');
             INSERT INTO branches (id, tenant_id, name, created_at, updated_at)
                VALUES ('branch-main','tenant-1','B','n','n'), ('branch-two','tenant-1','B2','n','n'),
                       ('branch-t2','tenant-2','B','n','n');
             INSERT INTO users (id, tenant_id, email, password_hash, name, created_at, updated_at)
                VALUES ('user-owner','tenant-1','a@b.c','h','Admin','n','n'),
                       ('user-t2','tenant-2','a@b.c','h','Admin','n','n');",
        )
        .unwrap();
    }

    fn migrated_mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        base_schema(&conn);
        run_migrations(&conn, crate::sync::migrations::EMBEDDED_MIGRATIONS).unwrap();
        conn
    }

    fn user(id: &str) -> CasPrincipal {
        CasPrincipal::User { user_id: id.into() }
    }
    fn device(id: &str) -> CasPrincipal {
        CasPrincipal::Device { device_id: id.into() }
    }
    fn system(id: &str) -> CasPrincipal {
        CasPrincipal::System { principal_id: id.into() }
    }
    #[allow(clippy::too_many_arguments)]
    fn op(
        oid: &str,
        tenant: &str,
        branch: &str,
        principal: CasPrincipal,
        record: &str,
        action: Action,
        base: i64,
        payload: &str,
    ) -> OperationInput {
        OperationInput {
            operation_id: oid.into(),
            tenant_id: tenant.into(),
            branch_id: branch.into(),
            principal,
            table_name: "products".into(),
            record_id: record.into(),
            action,
            base_revision: base,
            payload: payload.into(),
        }
    }
    // The default-principal builders keep the CAS/idempotency/tombstone tests principal-agnostic.
    fn ins(oid: &str, record: &str, payload: &str) -> OperationInput {
        op(oid, TENANT, BRANCH, user(PRINCIPAL), record, Action::Insert, 0, payload)
    }
    fn upd(oid: &str, record: &str, base: i64, payload: &str) -> OperationInput {
        op(oid, TENANT, BRANCH, user(PRINCIPAL), record, Action::Update, base, payload)
    }
    fn del(oid: &str, record: &str, base: i64) -> OperationInput {
        op(oid, TENANT, BRANCH, user(PRINCIPAL), record, Action::Delete, base, "{}")
    }
    fn apply1(conn: &mut Connection, o: OperationInput) -> OpResult {
        apply_operations(conn, NOW, &[o])
            .expect("batch must not be rejected")
            .pop()
            .unwrap()
    }
    fn revision(conn: &Connection, tenant: &str, branch: &str, record: &str) -> Option<i64> {
        conn.query_row(
            "SELECT current_revision FROM canonical_entities
              WHERE tenant_id=?1 AND branch_id=?2 AND table_name='products' AND record_id=?3",
            params![tenant, branch, record],
            |r| r.get(0),
        )
        .optional()
        .unwrap()
    }
    fn rev(conn: &Connection, record: &str) -> Option<i64> {
        revision(conn, TENANT, BRANCH, record)
    }
    fn tomb(conn: &Connection, record: &str) -> Option<bool> {
        conn.query_row(
            "SELECT is_tombstone FROM canonical_entities
              WHERE tenant_id=?1 AND branch_id=?2 AND table_name='products' AND record_id=?3",
            params![TENANT, BRANCH, record],
            |r| Ok(r.get::<_, i64>(0)? != 0),
        )
        .optional()
        .unwrap()
    }
    fn data(conn: &Connection, record: &str) -> Option<String> {
        conn.query_row(
            "SELECT canonical_data FROM canonical_entities
              WHERE tenant_id=?1 AND branch_id=?2 AND table_name='products' AND record_id=?3",
            params![TENANT, BRANCH, record],
            |r| r.get(0),
        )
        .optional()
        .unwrap()
    }
    fn ledger(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM operation_ledger", [], |r| r.get(0))
            .unwrap()
    }
    fn entity_rows(conn: &Connection, record: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM canonical_entities WHERE record_id=?1",
            params![record],
            |r| r.get(0),
        )
        .unwrap()
    }

    // ═══════════════════════ C1–C10: revision + CAS ═══════════════════════════
    #[test]
    fn c1_insert_base0_gives_revision_1() {
        let mut c = migrated_mem();
        let r = apply1(&mut c, ins("op1", "r1", P1));
        assert_eq!(r.status, OpStatus::Applied);
        assert_eq!(r.applied_revision, Some(1));
        assert_eq!(r.is_tombstone, Some(false));
        assert_eq!(rev(&c, "r1"), Some(1));
        assert_eq!(ledger(&c), 1);
    }

    #[test]
    fn c2_second_insert_same_entity_conflicts() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", P1));
        let r = apply1(&mut c, ins("op2", "r1", P2));
        assert_eq!(r.status, OpStatus::Conflict);
        assert_eq!(r.code.as_deref(), Some(ERR_REVISION_CONFLICT));
        assert_eq!(r.current_revision, Some(1));
        assert_eq!(rev(&c, "r1"), Some(1), "no mutation");
        assert_eq!(data(&c, "r1").as_deref(), Some(P1), "original data intact");
    }

    #[test]
    fn c3_update_correct_base_gives_revision_2() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", P1));
        let r = apply1(&mut c, upd("op2", "r1", 1, P2));
        assert_eq!(r.status, OpStatus::Applied);
        assert_eq!(r.applied_revision, Some(2));
        assert_eq!(rev(&c, "r1"), Some(2));
        assert_eq!(data(&c, "r1").as_deref(), Some(P2));
    }

    #[test]
    fn c4_update_stale_base_conflicts() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", P1));
        apply1(&mut c, upd("op2", "r1", 1, P2)); // → revision 2
        let r = apply1(&mut c, upd("op3", "r1", 1, P1)); // stale base 1
        assert_eq!(r.status, OpStatus::Conflict);
        assert_eq!(r.current_revision, Some(2));
        assert_eq!(rev(&c, "r1"), Some(2), "no mutation");
        assert_eq!(data(&c, "r1").as_deref(), Some(P2), "the applied update survives");
    }

    #[test]
    fn c5_delete_correct_base_tombstones_revision_3() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", P1)); // rev 1
        apply1(&mut c, upd("op2", "r1", 1, P2)); // rev 2
        let r = apply1(&mut c, del("op3", "r1", 2)); // rev 3, tombstone
        assert_eq!(r.status, OpStatus::Applied);
        assert_eq!(r.applied_revision, Some(3));
        assert_eq!(r.is_tombstone, Some(true));
        assert_eq!(rev(&c, "r1"), Some(3));
        assert_eq!(tomb(&c, "r1"), Some(true));
    }

    #[test]
    fn c6_update_against_tombstone_conflicts() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", P1)); // rev 1
        apply1(&mut c, del("op2", "r1", 1)); // rev 2, tombstone
        let r = apply1(&mut c, upd("op3", "r1", 2, P2)); // correct base but tombstoned
        assert_eq!(r.status, OpStatus::Conflict);
        assert_eq!(r.current_is_tombstone, Some(true));
        assert_eq!(r.current_revision, Some(2));
        assert_eq!(rev(&c, "r1"), Some(2), "no resurrection");
        assert_eq!(tomb(&c, "r1"), Some(true));
    }

    #[test]
    fn c7_insert_against_tombstone_conflicts() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", P1));
        apply1(&mut c, del("op2", "r1", 1)); // tombstone
        let r = apply1(&mut c, ins("op3", "r1", P2)); // insert over a tombstone
        assert_eq!(r.status, OpStatus::Conflict);
        assert_eq!(r.current_is_tombstone, Some(true));
        assert_eq!(rev(&c, "r1"), Some(2), "no resurrection");
    }

    #[test]
    fn c8_delete_against_tombstone_new_op_id_conflicts() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", P1));
        apply1(&mut c, del("op2", "r1", 1)); // tombstone at rev 2
        let r = apply1(&mut c, del("op3", "r1", 2)); // NEW op_id, correct base
        assert_eq!(r.status, OpStatus::Conflict, "re-delete with a new op_id is a conflict");
        assert_eq!(rev(&c, "r1"), Some(2), "no extra revision");
    }

    #[test]
    fn c9_other_tenant_same_record_id_is_independent() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", P1)); // tenant-1
        let r = apply1(
            &mut c,
            op("op2", "tenant-2", "branch-t2", user("user-t2"), "r1", Action::Insert, 0, P1),
        );
        assert_eq!(r.status, OpStatus::Applied, "different tenant, same record id → independent insert");
        assert_eq!(r.applied_revision, Some(1));
        assert_eq!(revision(&c, "tenant-1", "branch-main", "r1"), Some(1));
        assert_eq!(revision(&c, "tenant-2", "branch-t2", "r1"), Some(1));
    }

    #[test]
    fn c10_other_branch_same_record_id_is_independent() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", P1)); // branch-main
        let r = apply1(
            &mut c,
            op("op2", TENANT, "branch-two", user(PRINCIPAL), "r1", Action::Insert, 0, P1),
        );
        assert_eq!(r.status, OpStatus::Applied, "different branch, same record id → independent");
        assert_eq!(revision(&c, TENANT, "branch-main", "r1"), Some(1));
        assert_eq!(revision(&c, TENANT, "branch-two", "r1"), Some(1));
    }

    // ═══════════════════════ I1–I8: idempotency ═══════════════════════════════
    #[test]
    fn i1_insert_replay_no_second_revision() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", P1));
        let r = apply1(&mut c, ins("op1", "r1", P1)); // identical replay
        assert_eq!(r.status, OpStatus::IdempotentReplay);
        assert_eq!(r.applied_revision, Some(1), "original result unchanged");
        assert_eq!(rev(&c, "r1"), Some(1), "no second revision");
        assert_eq!(ledger(&c), 1, "no second ledger row");
    }

    #[test]
    fn i2_update_replay_no_second_revision() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", P1));
        apply1(&mut c, upd("op2", "r1", 1, P2));
        let r = apply1(&mut c, upd("op2", "r1", 1, P2)); // identical replay
        assert_eq!(r.status, OpStatus::IdempotentReplay);
        assert_eq!(r.applied_revision, Some(2));
        assert_eq!(rev(&c, "r1"), Some(2));
        assert_eq!(ledger(&c), 2);
    }

    #[test]
    fn i3_delete_replay_no_second_revision() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", P1));
        apply1(&mut c, del("op2", "r1", 1));
        let r = apply1(&mut c, del("op2", "r1", 1)); // identical replay
        assert_eq!(r.status, OpStatus::IdempotentReplay);
        assert_eq!(r.is_tombstone, Some(true));
        assert_eq!(rev(&c, "r1"), Some(2));
        assert_eq!(ledger(&c), 2);
    }

    #[test]
    fn i4_conflict_replay_returns_frozen_conflict() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", P1)); // rev 1
        let first = apply1(&mut c, upd("op2", "r1", 5, P2)); // conflict, current_revision 1
        assert_eq!(first.status, OpStatus::Conflict);
        assert_eq!(first.current_revision, Some(1));
        // advance the entity so a re-computed conflict would differ
        apply1(&mut c, upd("op3", "r1", 1, P1)); // rev 2
        let replay = apply1(&mut c, upd("op2", "r1", 5, P2)); // identical replay of the conflict
        assert_eq!(replay.status, OpStatus::IdempotentReplay);
        assert_eq!(replay.code.as_deref(), Some(ERR_REVISION_CONFLICT));
        assert_eq!(
            replay.current_revision,
            Some(1),
            "the conflict is FROZEN at the original revision, not recomputed to 2"
        );
        assert_eq!(replay.current_canonical_hash, first.current_canonical_hash);
    }

    #[test]
    fn i5_same_op_id_different_payload_is_reuse() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", P1));
        let r = apply1(&mut c, ins("op1", "r1", P2)); // same id, different payload
        assert_eq!(r.status, OpStatus::OperationIdReuse);
        assert_eq!(r.code.as_deref(), Some(ERR_OPERATION_ID_REUSE));
        assert_eq!(rev(&c, "r1"), Some(1), "no mutation");
        assert_eq!(data(&c, "r1").as_deref(), Some(P1));
        assert_eq!(ledger(&c), 1);
    }

    #[test]
    fn i6_same_op_id_different_base_is_reuse() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", P1));
        apply1(&mut c, upd("op2", "r1", 1, P2)); // rev 2
        let r = apply1(&mut c, upd("op2", "r1", 2, P2)); // same id, different base_revision
        assert_eq!(r.status, OpStatus::OperationIdReuse);
        assert_eq!(rev(&c, "r1"), Some(2), "no mutation");
        assert_eq!(ledger(&c), 2);
    }

    #[test]
    fn i7_same_op_id_different_entity_is_reuse() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", P1));
        let r = apply1(&mut c, ins("op1", "r2", P1)); // same id, different record
        assert_eq!(r.status, OpStatus::OperationIdReuse);
        assert_eq!(rev(&c, "r2"), None, "no mutation on the other entity");
        assert_eq!(ledger(&c), 1);
    }

    #[test]
    fn i8_request_hash_is_key_order_independent() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", r#"{"brand":"X","name":"Y"}"#));
        // same op_id, SAME data but reordered keys → identical request hash → replay, NOT reuse.
        let r = apply1(&mut c, ins("op1", "r1", r#"{"name":"Y","brand":"X"}"#));
        assert_eq!(
            r.status,
            OpStatus::IdempotentReplay,
            "key order must not change the request hash"
        );
        assert_eq!(ledger(&c), 1);
    }

    // ═══════════════════════ B1–B8: batch ═════════════════════════════════════
    #[test]
    fn b1_two_independent_successes() {
        let mut c = migrated_mem();
        let rs = apply_operations(&mut c, NOW, &[ins("opa", "r1", P1), ins("opb", "r2", P1)]).unwrap();
        assert_eq!(rs[0].status, OpStatus::Applied);
        assert_eq!(rs[1].status, OpStatus::Applied);
        assert_eq!(rev(&c, "r1"), Some(1));
        assert_eq!(rev(&c, "r2"), Some(1));
    }

    #[test]
    fn b2_conflict_a_does_not_block_success_b() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op0", "r1", P1)); // rev 1
        let rs = apply_operations(
            &mut c,
            NOW,
            &[upd("opa", "r1", 5, P2), ins("opb", "r2", P1)], // A conflicts, B applies
        )
        .unwrap();
        assert_eq!(rs[0].status, OpStatus::Conflict);
        assert_eq!(rs[1].status, OpStatus::Applied);
        assert_eq!(rev(&c, "r1"), Some(1), "A did not mutate");
        assert_eq!(rev(&c, "r2"), Some(1), "B applied despite A's conflict");
    }

    #[test]
    fn b3_two_updates_same_entity_follow_base_within_batch() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op0", "r1", P1)); // rev 1
        let rs = apply_operations(
            &mut c,
            NOW,
            &[upd("opa", "r1", 1, P2), upd("opb", "r1", 2, P1)], // second sees the first's revision
        )
        .unwrap();
        assert_eq!(rs[0].status, OpStatus::Applied);
        assert_eq!(rs[0].applied_revision, Some(2));
        assert_eq!(rs[1].status, OpStatus::Applied);
        assert_eq!(rs[1].applied_revision, Some(3), "later op sees the earlier op's revision");
        assert_eq!(rev(&c, "r1"), Some(3));
    }

    #[test]
    fn b4_second_update_same_entity_stale_conflicts() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op0", "r1", P1)); // rev 1
        let rs = apply_operations(
            &mut c,
            NOW,
            &[upd("opa", "r1", 1, P2), upd("opb", "r1", 1, P1)], // opb's base is now stale
        )
        .unwrap();
        assert_eq!(rs[0].status, OpStatus::Applied);
        assert_eq!(rs[1].status, OpStatus::Conflict);
        assert_eq!(rs[1].current_revision, Some(2));
        assert_eq!(rev(&c, "r1"), Some(2));
    }

    #[test]
    fn b5_identical_duplicate_op_id_in_batch_replays_deterministically() {
        let mut c = migrated_mem();
        let rs = apply_operations(&mut c, NOW, &[ins("opx", "r1", P1), ins("opx", "r1", P1)]).unwrap();
        assert_eq!(rs[0].status, OpStatus::Applied);
        assert_eq!(rs[1].status, OpStatus::IdempotentReplay);
        assert_eq!(rs[1].applied_revision, Some(1));
        assert_eq!(rev(&c, "r1"), Some(1));
        assert_eq!(ledger(&c), 1, "one ledger row for the shared op_id");
    }

    #[test]
    fn b6_different_duplicate_op_id_in_batch_is_preflight_rejected() {
        let mut c = migrated_mem();
        let err = apply_operations(
            &mut c,
            NOW,
            &[ins("opx", "r1", P1), upd("opx", "r1", 1, P2)], // same id, different requests
        )
        .unwrap_err();
        assert!(matches!(err, CasError::DuplicateOperationIdInBatch { .. }));
        assert_eq!(rev(&c, "r1"), None, "nothing processed");
        assert_eq!(ledger(&c), 0);
    }

    #[test]
    fn b7_b8_transient_error_rolls_the_whole_batch_back() {
        let mut c = migrated_mem();
        // The SECOND op names a branch that violates the canonical_entities FK (branches) → its
        // canonical INSERT errors AFTER the first op has already written its canonical + ledger rows
        // in this transaction. (There is deliberately no users FK on the ledger any more, so a bad
        // principal id is a preflight rejection, not a mid-transaction DB error — a bad branch is.)
        let bad_branch = op("opb", TENANT, "branch-GHOST", user(PRINCIPAL), "r2", Action::Insert, 0, P1);
        let err = apply_operations(&mut c, NOW, &[ins("opa", "r1", P1), bad_branch]).unwrap_err();
        assert!(matches!(err, CasError::Db(_)));
        // B8 — nothing survives: not r1's canonical row, not opa's ledger row.
        assert_eq!(rev(&c, "r1"), None, "the whole batch rolled back");
        assert_eq!(entity_rows(&c, "r2"), 0);
        assert_eq!(ledger(&c), 0, "no partial operation-ledger result");
    }

    // ═══════════════════════ T1–T5: tombstones ════════════════════════════════
    #[test]
    fn t1_delete_writes_a_tombstone_row_that_stays() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", P1));
        apply1(&mut c, del("op2", "r1", 1));
        assert_eq!(tomb(&c, "r1"), Some(true));
        assert_eq!(entity_rows(&c, "r1"), 1, "the row is NOT physically removed");
        assert_eq!(data(&c, "r1").as_deref(), Some(P1), "the tombstone remembers the last data");
    }

    #[test]
    fn t2_tombstone_is_returned_in_the_conflict_envelope() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", P1));
        apply1(&mut c, del("op2", "r1", 1)); // rev 2 tombstone
        let r = apply1(&mut c, upd("op3", "r1", 2, P2));
        assert_eq!(r.status, OpStatus::Conflict);
        assert_eq!(r.current_is_tombstone, Some(true));
        assert_eq!(r.current_revision, Some(2));
    }

    #[test]
    fn t3_stale_update_cannot_resurrect() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", P1));
        apply1(&mut c, del("op2", "r1", 1)); // tombstone at rev 2
        let r = apply1(&mut c, upd("op3", "r1", 2, P2)); // even the CORRECT base cannot resurrect
        assert_eq!(r.status, OpStatus::Conflict);
        assert_eq!(tomb(&c, "r1"), Some(true), "still a tombstone");
        assert_eq!(rev(&c, "r1"), Some(2), "no new revision");
        assert_eq!(data(&c, "r1").as_deref(), Some(P1), "data unchanged");
    }

    #[test]
    fn t4_stale_insert_cannot_resurrect() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", P1));
        apply1(&mut c, del("op2", "r1", 1)); // tombstone
        let r = apply1(&mut c, ins("op3", "r1", P2));
        assert_eq!(r.status, OpStatus::Conflict);
        assert_eq!(tomb(&c, "r1"), Some(true));
        assert_eq!(rev(&c, "r1"), Some(2), "no resurrection, no new revision");
    }

    #[test]
    fn t5_idempotent_delete_replay_stays_successful() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", P1));
        let first = apply1(&mut c, del("op2", "r1", 1)); // rev 2 tombstone
        assert_eq!(first.status, OpStatus::Applied);
        let replay = apply1(&mut c, del("op2", "r1", 1)); // identical op_id
        assert_eq!(replay.status, OpStatus::IdempotentReplay);
        assert_eq!(replay.applied_revision, Some(2), "the original successful delete");
        assert_eq!(rev(&c, "r1"), Some(2), "no extra revision");
        assert_eq!(ledger(&c), 2);
    }

    // ═══════════════════════ P1–P6: typed principals (M6-B3B1A) ═══════════════
    fn ptype_of(conn: &Connection, oid: &str) -> String {
        conn.query_row(
            "SELECT principal_type FROM operation_ledger WHERE operation_id=?1",
            params![oid],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn p1_device_principal_executes_without_a_users_row() {
        let mut c = migrated_mem();
        let r = apply1(&mut c, op("op1", TENANT, BRANCH, device("dev-ed25519-1"), "r1", Action::Insert, 0, P1));
        assert_eq!(r.status, OpStatus::Applied);
        assert_eq!(rev(&c, "r1"), Some(1));
        let in_users: i64 = c
            .query_row("SELECT COUNT(*) FROM users WHERE id='dev-ed25519-1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(in_users, 0, "a device principal has NO users row");
        assert_eq!(ptype_of(&c, "op1"), "device");
    }

    #[test]
    fn p2_device_replay_is_idempotent() {
        let mut c = migrated_mem();
        apply1(&mut c, op("op1", TENANT, BRANCH, device("dev-1"), "r1", Action::Insert, 0, P1));
        let r = apply1(&mut c, op("op1", TENANT, BRANCH, device("dev-1"), "r1", Action::Insert, 0, P1));
        assert_eq!(r.status, OpStatus::IdempotentReplay);
        assert_eq!(rev(&c, "r1"), Some(1));
        assert_eq!(ledger(&c), 1);
    }

    #[test]
    fn p3_other_device_same_op_id_is_reuse() {
        let mut c = migrated_mem();
        apply1(&mut c, op("op1", TENANT, BRANCH, device("dev-1"), "r1", Action::Insert, 0, P1));
        let r = apply1(&mut c, op("op1", TENANT, BRANCH, device("dev-2"), "r1", Action::Insert, 0, P1));
        assert_eq!(r.status, OpStatus::OperationIdReuse, "another device reusing an op_id → reuse");
        assert_eq!(rev(&c, "r1"), Some(1), "no mutation");
    }

    #[test]
    fn p4_system_principal_executes() {
        let mut c = migrated_mem();
        let r = apply1(&mut c, op("ops", TENANT, BRANCH, system("self-desktop"), "r1", Action::Insert, 0, P1));
        assert_eq!(r.status, OpStatus::Applied);
        assert_eq!(ptype_of(&c, "ops"), "system");
    }

    #[test]
    fn p5_user_principal_still_works() {
        let mut c = migrated_mem();
        let r = apply1(&mut c, ins("opu", "r1", P1)); // ins() uses a user principal
        assert_eq!(r.status, OpStatus::Applied);
        assert_eq!(ptype_of(&c, "opu"), "user");
    }

    #[test]
    fn p6_same_id_string_as_user_and_device_stays_distinct() {
        let mut c = migrated_mem();
        apply1(&mut c, op("opA", TENANT, BRANCH, user("shared"), "r1", Action::Insert, 0, P1));
        // Same op_id, same id STRING, but a device → a DIFFERENT principal → reuse, not replay.
        let r = apply1(&mut c, op("opA", TENANT, BRANCH, device("shared"), "r1", Action::Insert, 0, P1));
        assert_eq!(r.status, OpStatus::OperationIdReuse, "user{{shared}} != device{{shared}}");
    }

    #[test]
    fn invalid_principal_id_is_rejected() {
        let mut c = migrated_mem();
        let mut reject = |p: CasPrincipal| {
            apply_operations(&mut c, NOW, &[op("o", TENANT, BRANCH, p, "r1", Action::Insert, 0, P1)]).unwrap_err()
        };
        let long = "x".repeat(MAX_PRINCIPAL_ID_LEN + 1);
        for (label, p) in [
            ("empty", user("")),
            ("over-long", device(&long)),
            ("control char", system("a\nb")),
        ] {
            assert!(
                matches!(reject(p), CasError::ValidationRejected { code, .. } if code == ERR_PRINCIPAL_INVALID),
                "{label} principal id must be a validation rejection"
            );
        }
        assert_eq!(rev(&c, "r1"), None, "nothing applied");
    }

    // ═══════════════════════ H1–H4: request-hash binding ══════════════════════
    #[test]
    fn h1_h4_request_hash_binds_all_fields() {
        let base = op("o", TENANT, BRANCH, user("u1"), "r1", Action::Insert, 0, r#"{"brand":"X","name":"Y"}"#);
        let h = |o: &OperationInput| request_hash(o).unwrap();
        let hbase = h(&base);
        let mut t = base.clone(); t.principal = system("u1");
        assert_ne!(h(&t), hbase, "H1: principal_type changes the hash");
        let mut t = base.clone(); t.principal = user("u2");
        assert_ne!(h(&t), hbase, "H2: principal_id changes the hash");
        let mut t = base.clone(); t.tenant_id = "tenant-2".into();
        assert_ne!(h(&t), hbase, "H3: tenant changes the hash");
        let mut t = base.clone(); t.branch_id = "branch-two".into();
        assert_ne!(h(&t), hbase, "H3: branch changes the hash");
        // defence in depth — action / base_revision / record / payload.
        let mut t = base.clone(); t.action = Action::Update;
        assert_ne!(h(&t), hbase, "action changes the hash");
        let mut t = base.clone(); t.base_revision = 1;
        assert_ne!(h(&t), hbase, "base_revision changes the hash");
        let mut t = base.clone(); t.record_id = "r2".into();
        assert_ne!(h(&t), hbase, "record changes the hash");
        let mut t = base.clone(); t.payload = r#"{"brand":"Z","name":"Y"}"#.into();
        assert_ne!(h(&t), hbase, "payload changes the hash");
        // H4 — JSON key order does NOT change the hash.
        let mut t = base.clone(); t.payload = r#"{"name":"Y","brand":"X"}"#.into();
        assert_eq!(h(&t), hbase, "H4: key order is canonicalised away");
    }

    // ═══════════════════════ §8: v0001 legacy CAS tables stay deprecated ══════
    #[test]
    fn engine_writes_only_v0010_tables_leaving_v0001_legacy_untouched() {
        let mut c = migrated_mem();
        apply1(&mut c, ins("op1", "r1", P1));
        apply1(&mut c, upd("op2", "r1", 1, P2));
        // the NEW v0010 tables carry the state.
        let count = |t: &str| c.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!(count("canonical_entities"), 1);
        assert_eq!(count("operation_ledger"), 2);
        // the FROZEN v0001 CAS scaffolding is NEVER written by the engine.
        assert_eq!(count("canonical_records"), 0, "legacy canonical_records stays empty");
        assert_eq!(count("operations"), 0, "legacy operations stays empty");
        // Source gate: the engine's SQL names ONLY the v0010 tables in read/write positions. The
        // needles are BUILT at runtime (verb + table), so this test's own source — which names the
        // legacy tables in prose and in these very arrays — does NOT self-match; only an actual
        // `<verb> <legacy_table>` adjacency in real SQL trips it.
        let verbs = ["FROM ", "INTO ", "UPDATE ", "DELETE FROM "];
        let engine_src = include_str!("cas_engine.rs");
        for v in verbs {
            for t in ["canonical_records", "operations"] {
                let needle = format!("{v}{t}");
                assert!(!engine_src.contains(&needle), "cas_engine must not touch legacy CAS SQL: {needle:?}");
            }
        }
        // …and no sync route reads or writes ANY CAS table (the engine is unrouted).
        let routes_src = include_str!("routes.rs");
        for v in verbs {
            for t in ["canonical_entities", "operation_ledger", "canonical_records", "operations"] {
                let needle = format!("{v}{t}");
                assert!(!routes_src.contains(&needle), "no route may touch a CAS table: {needle:?}");
            }
        }
    }

    // ═══════════════════════ §13: real two-connection race ════════════════════

    /// RAII temp DB path: removes the file and any journal/WAL/SHM sidecars on drop so the race test
    /// leaves nothing behind.
    struct TempDb(std::path::PathBuf);
    impl Drop for TempDb {
        fn drop(&mut self) {
            let p = self.0.to_string_lossy().to_string();
            for suffix in ["", "-journal", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{p}{suffix}"));
            }
        }
    }
    fn temp_db_path() -> TempDb {
        let name = format!("b3b1-cas-race-{}.db", uuid::Uuid::new_v4());
        TempDb(std::env::temp_dir().join(name))
    }
    fn open_file(path: &std::path::Path) -> Connection {
        let c = Connection::open(path).unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        c.busy_timeout(Duration::from_secs(20)).unwrap();
        c
    }

    #[test]
    fn race_two_connections_exactly_one_applies_one_conflicts() {
        let temp = temp_db_path();
        // Set up a shared file DB with an entity at revision 1.
        {
            let mut c = open_file(&temp.0);
            base_schema(&c);
            run_migrations(&c, crate::sync::migrations::EMBEDDED_MIGRATIONS).unwrap();
            apply1(&mut c, ins("op-seed", "r1", P1));
            assert_eq!(rev(&c, "r1"), Some(1));
        }
        // Two threads, two independent connections, each attempting an UPDATE at base_revision 1.
        // The immediate transaction serializes the writers; whichever commits first advances the
        // revision, and the other's CAS (base 1 vs current 2) conflicts. Exactly one of each.
        let path = temp.0.clone();
        let handles: Vec<_> = (0..2)
            .map(|i| {
                let p = path.clone();
                std::thread::spawn(move || {
                    let mut c = open_file(&p);
                    let payload = format!(r#"{{"brand":"racer{i}","name":"Y"}}"#);
                    apply1(&mut c, upd(&format!("op-race-{i}"), "r1", 1, &payload)).status
                })
            })
            .collect();
        let statuses: Vec<OpStatus> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let applied = statuses.iter().filter(|s| **s == OpStatus::Applied).count();
        let conflict = statuses.iter().filter(|s| **s == OpStatus::Conflict).count();
        assert_eq!(applied, 1, "exactly one APPLIED");
        assert_eq!(conflict, 1, "exactly one SYNC_REVISION_CONFLICT");

        let c = open_file(&temp.0);
        assert_eq!(rev(&c, "r1"), Some(2), "final revision is N+1 — no lost update");
        // seed insert + two race ops (one applied row, one conflict row) — no duplicate ledger row.
        assert_eq!(ledger(&c), 3);
        let applied_ops: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM operation_ledger WHERE result_status='applied'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(applied_ops, 2, "seed insert + exactly one applied race update");
    }
}
