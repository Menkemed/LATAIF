//! M6-B3B2 / MEDIA-04A-3B2C4B1 (+R1) — the versioned operation protocol (V2). **INACTIVE.**
//!
//! Binds the server-authoritative CAS core (`cas_engine`, M6-B3B1) and the durable operation
//! identity into ONE versioned internal contract. NOTHING here is wired to `/api/sync/push`,
//! `/api/sync/pull`, the legacy desktop/mobile push, or any route — no production caller exists yet.
//! The legacy `/sync/push` path stays byte-for-byte unchanged and is still NOT mobile-exactly-once.
//!
//! ## R1 — trusted writer identity (never self-authorised)
//! Every batch runs under a `TrustedContext { tenant, branch, writer }` the CALLER supplies (a route
//! would derive it from the verified JWT / device certificate). Each envelope's `tenant`/`branch`/
//! `writer` must EQUAL the trusted context exactly, else the message is a typed
//! `IdentityConflict` — no mutation, no ledger/changelog/audit. The operation key + principal are
//! built from the TRUSTED identity, so a client can never re-run (or steal) an operation by changing
//! the envelope's `writer_id`.
//!
//! ## Canonical operation identity
//! The CAS operation id is the SHA-256 of a canonical JSON array
//! `[tenant, branch, writer_kind, writer_id, operation_id]` — JSON-escaped, so no special char or
//! prefix overlap can make two distinct keys collide; `operation_id` is length-bounded (fail-closed).
//! The `payload_hash` is NOT trusted from the client: the server recomputes it from a CANONICAL
//! (key-sorted) representation of the payload and refuses a mismatch, so JSON key order can never
//! cause a false conflict. The full operation intent (protocol, trusted identity, table/entity/
//! action, expected revision, canonical payload) is bound by the trusted check + the composite key +
//! `cas_engine`'s canonical request hash.
//!
//! ## CAS + atomicity + concurrency
//! Each op runs through `cas_engine` (server-assigned monotone revision, real `base_revision` CAS,
//! tombstone-on-delete, explicit revision-valid `Recreate`, frozen `operation_ledger`). In the SAME
//! immediate transaction each APPLIED op writes exactly ONE `sync_operation_changelog` + ONE
//! `sync_operation_audit` (v0011); a conflict/replay writes neither. Under two concurrent writers at
//! revision N, SQLite's write lock + the CAS guard admit exactly one applied (N+1); the other is a
//! `RevisionConflict`. A retry of a committed op replays the frozen ledger result and never
//! double-writes.

// INACTIVE by design: exercised only by this module's tests until a later slice adds a real caller.
#![allow(dead_code)]

use rusqlite::{params, Connection, TransactionBehavior};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::cas_engine::{self, Action, CasError, CasPrincipal, OpResult, OpStatus, OperationInput};

/// The V2 wire protocol version. A message declaring any other version is refused.
pub const V2_PROTOCOL_VERSION: i64 = 2;
/// Fail-closed upper bound on the wire `operation_id` (a UUID/event id is far shorter).
pub const MAX_OPERATION_ID_LEN: usize = 200;

// ── activation-block / validation / identity codes ───────────────────────────
pub const ERR_ACTIVATION_NO_WRITER_ID: &str = "V2_ACTIVATION_BLOCKED_NO_WRITER_ID";
pub const ERR_ACTIVATION_NO_OPERATION_ID: &str = "V2_ACTIVATION_BLOCKED_NO_OPERATION_ID";
pub const ERR_ACTIVATION_NO_EXPECTED_REVISION: &str = "V2_ACTIVATION_BLOCKED_NO_EXPECTED_REVISION";
pub const ERR_UNSUPPORTED_PROTOCOL: &str = "V2_UNSUPPORTED_PROTOCOL_VERSION";
pub const ERR_PAYLOAD_HASH_MISMATCH: &str = "V2_PAYLOAD_HASH_MISMATCH";
pub const ERR_SCOPE_REQUIRED: &str = "V2_SCOPE_REQUIRED";
pub const ERR_OPERATION_ID_TOO_LONG: &str = "V2_OPERATION_ID_TOO_LONG";
pub const ERR_IDENTITY_CONFLICT: &str = "V2_IDENTITY_CONFLICT";
pub const ERR_PAYLOAD_INVALID: &str = "V2_PAYLOAD_INVALID";

/// The V2 writer identity (mirrors `CasPrincipal`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V2Writer {
    User(String),
    Device(String),
    System(String),
}
impl V2Writer {
    fn id(&self) -> &str {
        match self {
            V2Writer::User(s) | V2Writer::Device(s) | V2Writer::System(s) => s,
        }
    }
    fn kind(&self) -> &'static str {
        match self {
            V2Writer::User(_) => "user",
            V2Writer::Device(_) => "device",
            V2Writer::System(_) => "system",
        }
    }
    fn to_principal(&self) -> CasPrincipal {
        match self {
            V2Writer::User(id) => CasPrincipal::User { user_id: id.clone() },
            V2Writer::Device(id) => CasPrincipal::Device { device_id: id.clone() },
            V2Writer::System(id) => CasPrincipal::System { principal_id: id.clone() },
        }
    }
}

/// The already-authenticated caller context. Supplied by the (future) route AFTER it verifies the
/// JWT / device certificate — the engine NEVER lets an envelope self-authorise its identity.
#[derive(Debug, Clone)]
pub struct TrustedContext {
    pub tenant_id: String,
    pub branch_id: String,
    pub writer: V2Writer,
}

/// A versioned V2 operation message. `Option` fields model wire-absence → an activation block.
#[derive(Debug, Clone)]
pub struct V2Envelope {
    pub protocol_version: i64,
    pub tenant_id: String,
    pub branch_id: String,
    pub writer: Option<V2Writer>,
    pub operation_id: Option<String>,
    pub table_name: String,
    pub entity_id: String,
    pub action: Action,
    pub expected_revision: Option<i64>,
    pub payload_hash: String,
    pub payload: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V2Status {
    Applied,
    Idempotent,
    OperationConflict,
    RevisionConflict,
}

#[derive(Debug, Clone)]
pub struct V2Outcome {
    pub status: V2Status,
    pub result: OpResult,
}

#[derive(Debug)]
pub enum V2Error {
    ActivationBlocked { index: usize, code: &'static str },
    Invalid { index: usize, code: &'static str },
    /// The envelope's identity does not match the trusted caller context.
    IdentityConflict { index: usize, code: &'static str },
    Cas(CasError),
    Db(rusqlite::Error),
}

fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

/// Deterministic, key-sorted JSON serialisation (canonical form). Object keys are recursively
/// sorted; strings/numbers use serde's escaping — so the output is unambiguous regardless of the
/// caller's key order or spacing.
fn canonical_json(v: &Value) -> String {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .iter()
                .map(|k| format!("{}:{}", serde_json::to_string(k).unwrap(), canonical_json(&m[*k])))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(a) => format!("[{}]", a.iter().map(canonical_json).collect::<Vec<_>>().join(",")),
        other => serde_json::to_string(other).unwrap(),
    }
}

/// The canonical payload hash the SERVER computes (never blindly the client's value): SHA-256 over
/// the key-sorted payload. An empty payload hashes as JSON `null`.
fn canonical_payload_hash(payload: &str) -> Result<String, &'static str> {
    let v: Value = if payload.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(payload).map_err(|_| ERR_PAYLOAD_INVALID)?
    };
    Ok(sha256_hex(&canonical_json(&v)))
}

/// The composite CAS operation id from the trusted op key. A canonical JSON array of the parts is
/// hashed, so special characters / prefix overlaps in any part cannot collide two distinct keys.
fn composite_operation_id(tenant: &str, branch: &str, writer: &V2Writer, operation_id: &str) -> String {
    let key = serde_json::json!([tenant, branch, writer.kind(), writer.id(), operation_id]);
    sha256_hex(&canonical_json(&key))
}

/// Validate a V2 envelope against the trusted context and lower it to a CAS `OperationInput` built
/// from the TRUSTED identity. Fail-closed with typed codes; nothing is written here.
fn lower(index: usize, trusted: &TrustedContext, env: &V2Envelope) -> Result<OperationInput, V2Error> {
    if env.protocol_version != V2_PROTOCOL_VERSION {
        return Err(V2Error::Invalid { index, code: ERR_UNSUPPORTED_PROTOCOL });
    }
    // ── activation guard: the three fields whose absence forbids exactly-once ──
    let writer = match &env.writer {
        Some(w) if !w.id().is_empty() => w,
        _ => return Err(V2Error::ActivationBlocked { index, code: ERR_ACTIVATION_NO_WRITER_ID }),
    };
    let operation_id = match &env.operation_id {
        Some(s) if !s.is_empty() => s.as_str(),
        _ => return Err(V2Error::ActivationBlocked { index, code: ERR_ACTIVATION_NO_OPERATION_ID }),
    };
    let expected_revision = match env.expected_revision {
        Some(r) => r,
        None => return Err(V2Error::ActivationBlocked { index, code: ERR_ACTIVATION_NO_EXPECTED_REVISION }),
    };
    if env.tenant_id.is_empty() || env.branch_id.is_empty() {
        return Err(V2Error::Invalid { index, code: ERR_SCOPE_REQUIRED });
    }
    // ── trusted-identity binding: the envelope may not self-authorise ──
    if env.tenant_id != trusted.tenant_id
        || env.branch_id != trusted.branch_id
        || writer != &trusted.writer
    {
        return Err(V2Error::IdentityConflict { index, code: ERR_IDENTITY_CONFLICT });
    }
    if operation_id.len() > MAX_OPERATION_ID_LEN {
        return Err(V2Error::Invalid { index, code: ERR_OPERATION_ID_TOO_LONG });
    }
    // ── payload integrity: server-computed canonical hash must match the declared one ──
    let canon = canonical_payload_hash(&env.payload).map_err(|code| V2Error::Invalid { index, code })?;
    if env.payload_hash.to_lowercase() != canon {
        return Err(V2Error::Invalid { index, code: ERR_PAYLOAD_HASH_MISMATCH });
    }
    Ok(OperationInput {
        operation_id: composite_operation_id(&trusted.tenant_id, &trusted.branch_id, &trusted.writer, operation_id),
        tenant_id: trusted.tenant_id.clone(),
        branch_id: trusted.branch_id.clone(),
        principal: trusted.writer.to_principal(),
        table_name: env.table_name.clone(),
        record_id: env.entity_id.clone(),
        action: env.action,
        base_revision: expected_revision,
        payload: env.payload.clone(),
    })
}

fn v2_status(op: &OpResult) -> V2Status {
    match op.status {
        OpStatus::Applied => V2Status::Applied,
        OpStatus::IdempotentReplay => V2Status::Idempotent,
        OpStatus::OperationIdReuse => V2Status::OperationConflict,
        OpStatus::Conflict => V2Status::RevisionConflict,
    }
}

/// Apply a batch of V2 messages under a trusted caller context. Whole-batch preflight first (any
/// activation/identity/validation failure rejects the batch with nothing processed), then ONE
/// transaction: CAS via `cas_engine`, plus — for each APPLIED op — exactly one changelog + one audit.
pub fn apply_v2(
    conn: &mut Connection,
    now: &str,
    trusted: &TrustedContext,
    envelopes: &[V2Envelope],
) -> Result<Vec<V2Outcome>, V2Error> {
    let mut inputs = Vec::with_capacity(envelopes.len());
    for (i, env) in envelopes.iter().enumerate() {
        inputs.push(lower(i, trusted, env)?);
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(V2Error::Db)?;
    let results = cas_engine::apply_operations_in_tx(&tx, now, &inputs).map_err(V2Error::Cas)?;
    for res in results.iter() {
        if res.status != OpStatus::Applied {
            continue; // conflict/replay: no mutation → no changelog, no audit, no double-write
        }
        let revision = res.applied_revision.expect("applied op carries a revision");
        let hash = res.canonical_hash.as_deref().expect("applied op carries a canonical hash");
        let tombstone = res.is_tombstone.unwrap_or(false) as i64;
        tx.execute(
            "INSERT INTO sync_operation_changelog
               (tenant_id, branch_id, table_name, record_id, action, revision, canonical_hash,
                is_tombstone, operation_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                res.tenant_id, res.branch_id, res.table_name, res.record_id,
                res.action.as_str(), revision, hash, tombstone, res.operation_id, now
            ],
        )
        .map_err(V2Error::Db)?;
        tx.execute(
            "INSERT INTO sync_operation_audit
               (operation_id, tenant_id, branch_id, principal_type, principal_id, table_name,
                record_id, action, applied_revision, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                res.operation_id, res.tenant_id, res.branch_id, trusted.writer.kind(),
                trusted.writer.id(), res.table_name, res.record_id, res.action.as_str(), revision, now
            ],
        )
        .map_err(V2Error::Db)?;
    }
    tx.commit().map_err(V2Error::Db)?;
    Ok(results.into_iter().map(|r| V2Outcome { status: v2_status(&r), result: r }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lataif_server::migrations::{run_migrations, Migration};
    use crate::sync::migrations::EMBEDDED_MIGRATIONS;
    use rusqlite::{Connection, OpenFlags};

    const T: &str = "tenant-1";
    const B: &str = "branch-main";
    const WRITER: &str = "dev-A";
    const NOW: &str = "2026-07-26T00:00:00Z";
    const TABLE: &str = "products";
    const P1: &str = r#"{"brand":"X","name":"Y"}"#;
    const P2: &str = r#"{"brand":"Z","name":"Y"}"#;

    fn base_sql() -> &'static str {
        "PRAGMA foreign_keys=ON;
         CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
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
         INSERT INTO tenants VALUES ('tenant-1','T','t','now','now');
         INSERT INTO tenants VALUES ('tenant-2','T2','t2','now','now');
         INSERT INTO branches VALUES ('branch-main','tenant-1','B','now','now');
         INSERT INTO branches VALUES ('branch-2','tenant-2','B2','now','now');"
    }
    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(base_sql()).unwrap();
        run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        conn
    }
    fn trusted() -> TrustedContext {
        TrustedContext { tenant_id: T.into(), branch_id: B.into(), writer: V2Writer::Device(WRITER.into()) }
    }
    fn env(action: Action, op_id: &str, expected: Option<i64>, payload: &str) -> V2Envelope {
        V2Envelope {
            protocol_version: V2_PROTOCOL_VERSION,
            tenant_id: T.into(),
            branch_id: B.into(),
            writer: Some(V2Writer::Device(WRITER.into())),
            operation_id: Some(op_id.into()),
            table_name: TABLE.into(),
            entity_id: "p1".into(),
            action,
            expected_revision: expected,
            payload_hash: canonical_payload_hash(payload).unwrap(),
            payload: payload.into(),
        }
    }
    fn one(conn: &mut Connection, e: V2Envelope) -> V2Outcome {
        apply_v2(conn, NOW, &trusted(), &[e]).unwrap().pop().unwrap()
    }
    fn cnt(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn create_idempotent_and_no_double() {
        let mut c = db();
        let r = one(&mut c, env(Action::Insert, "op-1", Some(0), P1));
        assert_eq!(r.status, V2Status::Applied);
        assert_eq!((cnt(&c, "sync_operation_changelog"), cnt(&c, "sync_operation_audit")), (1, 1));
        let r2 = one(&mut c, env(Action::Insert, "op-1", Some(0), P1));
        assert_eq!(r2.status, V2Status::Idempotent);
        assert_eq!((cnt(&c, "canonical_entities"), cnt(&c, "sync_operation_changelog"), cnt(&c, "sync_operation_audit")), (1, 1, 1));
    }

    #[test]
    fn trusted_writer_mismatch_is_identity_conflict_no_write() {
        let mut c = db();
        // envelope claims a DIFFERENT writer than the trusted caller → identity conflict.
        let mut e = env(Action::Insert, "op-1", Some(0), P1);
        e.writer = Some(V2Writer::Device("dev-EVIL".into()));
        match apply_v2(&mut c, NOW, &trusted(), &[e]) {
            Err(V2Error::IdentityConflict { code, .. }) => assert_eq!(code, ERR_IDENTITY_CONFLICT),
            other => panic!("expected identity conflict, got {:?}", other),
        }
        // a mismatched tenant/branch is equally refused
        let mut e2 = env(Action::Insert, "op-1", Some(0), P1);
        e2.tenant_id = "tenant-2".into();
        assert!(matches!(apply_v2(&mut c, NOW, &trusted(), &[e2]), Err(V2Error::IdentityConflict { .. })));
        assert_eq!((cnt(&c, "canonical_entities"), cnt(&c, "operation_ledger"), cnt(&c, "sync_operation_changelog")), (0, 0, 0));
    }

    #[test]
    fn cannot_rerun_by_changing_writer_id() {
        let mut c = db();
        // dev-A applies op-1.
        assert_eq!(one(&mut c, env(Action::Insert, "op-1", Some(0), P1)).status, V2Status::Applied);
        // A second CALLER (trusted dev-B) with the SAME operation_id is a DIFFERENT operation key —
        // it hits the existing entity → revision conflict, never a silent re-run or resurrection.
        let tb = TrustedContext { tenant_id: T.into(), branch_id: B.into(), writer: V2Writer::Device("dev-B".into()) };
        let mut e = env(Action::Insert, "op-1", Some(0), P1);
        e.writer = Some(V2Writer::Device("dev-B".into()));
        let r = apply_v2(&mut c, NOW, &tb, &[e]).unwrap().pop().unwrap();
        assert_eq!(r.status, V2Status::RevisionConflict);
        assert_eq!(cnt(&c, "canonical_entities"), 1); // still exactly one entity
    }

    #[test]
    fn canonical_operation_identity() {
        // key-order independence: two payloads differing only in key order hash identically…
        let a = canonical_payload_hash(r#"{"a":1,"b":2}"#).unwrap();
        let b = canonical_payload_hash(r#"{"b":2,"a":1}"#).unwrap();
        assert_eq!(a, b);
        // …and the composite op key is collision-free across special chars / prefix overlaps.
        let w = V2Writer::Device("d".into());
        let k1 = composite_operation_id("t", "b", &w, "x\u{1f}y");
        let k2 = composite_operation_id("t", "b", &w, "x\u{1f}y2");
        let k3 = composite_operation_id("t\u{1f}b", "", &w, "x\u{1f}y"); // prefix-overlap attempt
        assert_ne!(k1, k2);
        assert_ne!(k1, k3);
        assert_ne!(k2, k3);
        // a reordered-key payload is NOT a false conflict: same op id + canonical-equal payload
        // replays. (Schema-valid product fields, only the key ORDER differs.)
        let mut c = db();
        assert_eq!(one(&mut c, env(Action::Insert, "op-1", Some(0), r#"{"brand":"X","name":"Y"}"#)).status, V2Status::Applied);
        assert_eq!(one(&mut c, env(Action::Insert, "op-1", Some(0), r#"{"name":"Y","brand":"X"}"#)).status, V2Status::Idempotent);
        assert_eq!(cnt(&c, "sync_operation_changelog"), 1);
        // over-long operation_id → fail closed
        let mut e = env(Action::Insert, &"x".repeat(MAX_OPERATION_ID_LEN + 1), Some(0), P1);
        e.payload_hash = canonical_payload_hash(P1).unwrap();
        assert!(matches!(apply_v2(&mut c, NOW, &trusted(), &[e]), Err(V2Error::Invalid { code, .. }) if code == ERR_OPERATION_ID_TOO_LONG));
    }

    #[test]
    fn payload_hash_recomputed_not_trusted() {
        let mut c = db();
        // a client that lies about the payload hash (declares the RAW non-canonical bytes' hash of a
        // DIFFERENT payload) is refused — the server verifies against its own canonical hash.
        let mut e = env(Action::Insert, "op-1", Some(0), P1);
        e.payload_hash = sha256_hex(P2);
        assert!(matches!(apply_v2(&mut c, NOW, &trusted(), &[e]), Err(V2Error::Invalid { code, .. }) if code == ERR_PAYLOAD_HASH_MISMATCH));
    }

    #[test]
    fn missing_fields_activation_block() {
        let mut c = db();
        let mut e = env(Action::Insert, "op-1", Some(0), P1); e.writer = None;
        assert!(matches!(apply_v2(&mut c, NOW, &trusted(), &[e]), Err(V2Error::ActivationBlocked { code, .. }) if code == ERR_ACTIVATION_NO_WRITER_ID));
        let mut e2 = env(Action::Insert, "op-1", Some(0), P1); e2.operation_id = None;
        assert!(matches!(apply_v2(&mut c, NOW, &trusted(), &[e2]), Err(V2Error::ActivationBlocked { code, .. }) if code == ERR_ACTIVATION_NO_OPERATION_ID));
        let e3 = env(Action::Insert, "op-1", None, P1);
        assert!(matches!(apply_v2(&mut c, NOW, &trusted(), &[e3]), Err(V2Error::ActivationBlocked { code, .. }) if code == ERR_ACTIVATION_NO_EXPECTED_REVISION));
        assert_eq!(cnt(&c, "canonical_entities"), 0);
    }

    #[test]
    fn stale_future_delete_recreate() {
        let mut c = db();
        one(&mut c, env(Action::Insert, "op-1", Some(0), P1));
        assert_eq!(one(&mut c, env(Action::Update, "op-2", Some(1), P2)).status, V2Status::Applied);
        assert_eq!(one(&mut c, env(Action::Update, "op-3", Some(1), P1)).status, V2Status::RevisionConflict); // stale
        assert_eq!(one(&mut c, env(Action::Update, "op-4", Some(9), P1)).status, V2Status::RevisionConflict); // future
        assert_eq!(one(&mut c, env(Action::Delete, "op-5", Some(2), P1)).result.is_tombstone, Some(true));
        assert_eq!(one(&mut c, env(Action::Insert, "op-6", Some(0), P2)).status, V2Status::RevisionConflict); // no resurrection
        let ok = one(&mut c, env(Action::Recreate, "op-7", Some(3), P2));
        assert_eq!((ok.status, ok.result.applied_revision, ok.result.is_tombstone), (V2Status::Applied, Some(4), Some(false)));
    }

    // ── R1 §3 — concurrent CAS with TWO independent connections on one shared DB ──
    fn shared(name: &str) -> Connection {
        let uri = format!("file:{name}?mode=memory&cache=shared");
        let c = Connection::open_with_flags(
            &uri,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_URI,
        )
        .unwrap();
        c.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
        c
    }

    #[test]
    fn concurrent_cas_single_winner() {
        let mut keeper = shared("b3b2r1_race"); // keeps the shared in-memory DB alive
        keeper.execute_batch(base_sql()).unwrap();
        run_migrations(&keeper, EMBEDDED_MIGRATIONS).unwrap();
        // entity at revision 1
        one(&mut keeper, env(Action::Insert, "seed", Some(0), P1));
        let base_changelog = cnt(&keeper, "sync_operation_changelog");
        let mut c1 = shared("b3b2r1_race");
        let mut c2 = shared("b3b2r1_race");
        // two independent connections, BOTH expecting revision 1
        let ra = apply_v2(&mut c1, NOW, &trusted(), &[env(Action::Update, "op-A", Some(1), P2)]).unwrap().pop().unwrap();
        let rb = apply_v2(&mut c2, NOW, &trusted(), &[env(Action::Update, "op-B", Some(1), P1)]).unwrap().pop().unwrap();
        let applied = [ra.status, rb.status].iter().filter(|s| **s == V2Status::Applied).count();
        let conflict = [ra.status, rb.status].iter().filter(|s| **s == V2Status::RevisionConflict).count();
        assert_eq!((applied, conflict), (1, 1), "exactly one winner, one revision conflict");
        let (rev, tomb): (i64, i64) = keeper.query_row(
            "SELECT current_revision, is_tombstone FROM canonical_entities WHERE record_id='p1'",
            [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((rev, tomb), (2, 0), "exactly one mutation → revision 2");
        assert_eq!(cnt(&keeper, "sync_operation_changelog") - base_changelog, 1, "exactly one changelog for the winner");
        // winner ledger applied, loser ledger conflict-frozen (2 rows for the two ops)
        let applied_ledger: i64 = keeper.query_row(
            "SELECT COUNT(*) FROM operation_ledger WHERE result_status='applied' AND base_revision=1", [], |r| r.get(0)).unwrap();
        assert_eq!(applied_ledger, 1);
    }

    #[test]
    fn concurrent_same_op_key_replays() {
        let mut keeper = shared("b3b2r1_dup");
        keeper.execute_batch(base_sql()).unwrap();
        run_migrations(&keeper, EMBEDDED_MIGRATIONS).unwrap();
        one(&mut keeper, env(Action::Insert, "seed", Some(0), P1)); // rev 1
        let mut c1 = shared("b3b2r1_dup");
        let mut c2 = shared("b3b2r1_dup");
        // same operation key + same payload from two connections → one commit, one stored result
        let ra = apply_v2(&mut c1, NOW, &trusted(), &[env(Action::Update, "op-X", Some(1), P2)]).unwrap().pop().unwrap();
        let rb = apply_v2(&mut c2, NOW, &trusted(), &[env(Action::Update, "op-X", Some(1), P2)]).unwrap().pop().unwrap();
        assert_eq!(ra.status, V2Status::Applied);
        assert_eq!(rb.status, V2Status::Idempotent);
        assert_eq!(ra.result.applied_revision, rb.result.applied_revision); // identical stored result
        let updates_changelog: i64 = keeper.query_row(
            "SELECT COUNT(*) FROM sync_operation_changelog WHERE action='update'", [], |r| r.get(0)).unwrap();
        assert_eq!(updates_changelog, 1, "no duplicate changelog");
    }

    #[test]
    fn crash_before_commit_persists_nothing() {
        let mut c = db();
        let input = lower(0, &trusted(), &env(Action::Insert, "op-1", Some(0), P1)).unwrap();
        {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate).unwrap();
            let res = cas_engine::apply_operations_in_tx(&tx, NOW, &[input]).unwrap();
            assert_eq!(res[0].status, OpStatus::Applied);
            // crash / save-failure AFTER the in-memory tx, BEFORE commit → drop the tx.
        }
        assert_eq!((cnt(&c, "canonical_entities"), cnt(&c, "sync_operation_changelog")), (0, 0));
        assert_eq!(one(&mut c, env(Action::Insert, "op-1", Some(0), P1)).status, V2Status::Applied);
    }

    // ── R2 §1 — the canonical request hash binds EVERY semantic field ──
    #[test]
    fn full_request_identity_binds_all_fields() {
        let mut c = db();
        assert_eq!(one(&mut c, env(Action::Insert, "op-1", Some(0), P1)).status, V2Status::Applied);
        // same op key + same payload, DIFFERENT action → OperationConflict (not a silent replay)
        assert_eq!(one(&mut c, env(Action::Update, "op-1", Some(0), P1)).status, V2Status::OperationConflict);
        // same op key + same payload, DIFFERENT expectedRevision → OperationConflict
        assert_eq!(one(&mut c, env(Action::Insert, "op-1", Some(5), P1)).status, V2Status::OperationConflict);
        // same op key, DIFFERENT entityId → OperationConflict (record_id is in the request hash)
        let mut de = env(Action::Insert, "op-1", Some(0), P1);
        de.entity_id = "p2".into();
        assert_eq!(one(&mut c, de).status, V2Status::OperationConflict);
        // semantically identical request with a DIFFERENT JSON key order → same hash → replay
        assert_eq!(one(&mut c, env(Action::Insert, "op-1", Some(0), r#"{"name":"Y","brand":"X"}"#)).status, V2Status::Idempotent);
        // exactly one entity, one changelog, one audit survived all of the above
        assert_eq!((cnt(&c, "canonical_entities"), cnt(&c, "sync_operation_changelog"), cnt(&c, "sync_operation_audit")), (1, 1, 1));
    }

    // ── R2 §2 — concurrent CAS: prove EVERY counter + no loser side-effect ──
    #[test]
    fn concurrent_cas_full_counters() {
        let mut keeper = shared("b3b2r2_race");
        keeper.execute_batch(base_sql()).unwrap();
        run_migrations(&keeper, EMBEDDED_MIGRATIONS).unwrap();
        one(&mut keeper, env(Action::Insert, "seed", Some(0), P1)); // rev 1: 1 changelog, 1 audit
        let mut c1 = shared("b3b2r2_race");
        let mut c2 = shared("b3b2r2_race");
        let ra = apply_v2(&mut c1, NOW, &trusted(), &[env(Action::Update, "win", Some(1), P2)]).unwrap().pop().unwrap();
        let rb = apply_v2(&mut c2, NOW, &trusted(), &[env(Action::Update, "lose", Some(1), P1)]).unwrap().pop().unwrap();
        assert_eq!([ra.status, rb.status].iter().filter(|s| **s == V2Status::Applied).count(), 1);
        assert_eq!([ra.status, rb.status].iter().filter(|s| **s == V2Status::RevisionConflict).count(), 1);
        // exactly one mutation (rev 2)
        let rev: i64 = keeper.query_row("SELECT current_revision FROM canonical_entities WHERE record_id='p1'", [], |r| r.get(0)).unwrap();
        assert_eq!(rev, 2);
        // update-scoped: exactly 1 changelog + 1 audit (winner only) — loser contributed nothing
        assert_eq!(keeper.query_row::<i64,_,_>("SELECT COUNT(*) FROM sync_operation_changelog WHERE action='update'", [], |r| r.get(0)).unwrap(), 1);
        assert_eq!(keeper.query_row::<i64,_,_>("SELECT COUNT(*) FROM sync_operation_audit WHERE action='update'", [], |r| r.get(0)).unwrap(), 1);
        // winner ledger applied@base1 = 1; loser ledger conflict@base1 = 1 (frozen, no side effect)
        assert_eq!(keeper.query_row::<i64,_,_>("SELECT COUNT(*) FROM operation_ledger WHERE result_status='applied' AND base_revision=1", [], |r| r.get(0)).unwrap(), 1);
        assert_eq!(keeper.query_row::<i64,_,_>("SELECT COUNT(*) FROM operation_ledger WHERE result_status='conflict' AND base_revision=1", [], |r| r.get(0)).unwrap(), 1);
    }

    #[test]
    fn concurrent_same_op_key_totals_one_each() {
        let mut keeper = shared("b3b2r2_dup");
        keeper.execute_batch(base_sql()).unwrap();
        run_migrations(&keeper, EMBEDDED_MIGRATIONS).unwrap();
        one(&mut keeper, env(Action::Insert, "seed", Some(0), P1));
        let mut c1 = shared("b3b2r2_dup");
        let mut c2 = shared("b3b2r2_dup");
        let ra = apply_v2(&mut c1, NOW, &trusted(), &[env(Action::Update, "same", Some(1), P2)]).unwrap().pop().unwrap();
        let rb = apply_v2(&mut c2, NOW, &trusted(), &[env(Action::Update, "same", Some(1), P2)]).unwrap().pop().unwrap();
        assert_eq!((ra.status, rb.status), (V2Status::Applied, V2Status::Idempotent));
        // exactly one commit → one ledger for 'same', one update changelog, one update audit
        assert_eq!(keeper.query_row::<i64,_,_>("SELECT COUNT(*) FROM sync_operation_changelog WHERE action='update'", [], |r| r.get(0)).unwrap(), 1);
        assert_eq!(keeper.query_row::<i64,_,_>("SELECT COUNT(*) FROM sync_operation_audit WHERE action='update'", [], |r| r.get(0)).unwrap(), 1);
    }

    // ── R2 §3 — v0011 partial failure fails closed, clean retry converges ──
    #[test]
    fn v0011_partial_failure_fail_closed() {
        const PROBE_REF: &str = "CREATE TABLE IF NOT EXISTS b3b2r2_probe (id INTEGER PRIMARY KEY);";
        // up_sql creates a probe table then hits a broken statement → mid-migration failure.
        const PROBE_UP: &str = "CREATE TABLE IF NOT EXISTS b3b2r2_probe (id INTEGER PRIMARY KEY); \
                                INSERT INTO __surely_missing_table__ VALUES (1);";
        let broken = Migration { version: 11, name: "operation_changelog_audit", up_sql: PROBE_UP, reference_sql: PROBE_REF };

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(base_sql()).unwrap();
        // apply through v0010, then seed CAS data that must survive the failed v0011.
        run_migrations(&conn, &EMBEDDED_MIGRATIONS[..10]).unwrap();
        conn.execute(
            "INSERT INTO canonical_entities
               (tenant_id, branch_id, table_name, record_id, current_revision, canonical_data,
                is_tombstone, last_operation_id, canonical_hash, created_at, updated_at)
             VALUES ('tenant-1','branch-main','products','p9',1,'{}',0,'op0',
                     '0000000000000000000000000000000000000000000000000000000000000000','now','now')",
            [],
        ).unwrap();

        // inject the failure: [..10] (already applied) + broken v0011.
        let mut broken_list: Vec<Migration> = EMBEDDED_MIGRATIONS[..10].to_vec();
        broken_list.push(broken);
        let err = run_migrations(&conn, &broken_list);
        assert!(err.is_err(), "a failing v0011 must return an error (fail closed)");
        // schema version NOT advanced past 10; no half-activated v0011 structure.
        let max_ver: i64 = conn.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0)).unwrap();
        assert_eq!(max_ver, 10, "v0011 must not be marked applied");
        let probe: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='b3b2r2_probe'", [], |r| r.get(0)).unwrap();
        assert_eq!(probe, 0, "the partially-created structure was rolled back");
        for t in ["sync_operation_changelog", "sync_operation_audit"] {
            let e: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1", [t], |r| r.get(0)).unwrap();
            assert_eq!(e, 0, "no half-activatable V2 table after failure");
        }
        // v0010 data unchanged
        assert_eq!(conn.query_row::<i64,_,_>("SELECT current_revision FROM canonical_entities WHERE record_id='p9'", [], |r| r.get(0)).unwrap(), 1);

        // clean retry with the REAL migration list converges fully.
        let report = run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        assert_eq!(report.applied, vec![11]);
        for t in ["sync_operation_changelog", "sync_operation_audit"] {
            let e: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1", [t], |r| r.get(0)).unwrap();
            assert_eq!(e, 1, "v0011 fully applied on the clean retry");
        }
        assert_eq!(conn.query_row::<i64,_,_>("SELECT current_revision FROM canonical_entities WHERE record_id='p9'", [], |r| r.get(0)).unwrap(), 1);
    }

    // ── R1 §4 — v0011 migration compatibility on a realistic existing DB ──
    #[test]
    fn v0011_migration_compatibility() {
        // a realistic existing DB: base schema + some DESKTOP-like business tables already present.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(base_sql()).unwrap();
        conn.execute_batch(
            "CREATE TABLE products (id TEXT PRIMARY KEY, brand TEXT, images TEXT);
             CREATE TABLE invoices (id TEXT PRIMARY KEY, total TEXT);",
        )
        .unwrap();
        // no name collision with the v0011 tables before migrating
        for t in ["sync_operation_changelog", "sync_operation_audit"] {
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1", [t], |r| r.get(0)).unwrap();
            assert_eq!(exists, 0);
        }
        // migrate through v0010, seed CAS data, then apply v0011.
        let up_to_10 = &EMBEDDED_MIGRATIONS[..10];
        run_migrations(&conn, up_to_10).unwrap();
        conn.execute(
            "INSERT INTO canonical_entities
               (tenant_id, branch_id, table_name, record_id, current_revision, canonical_data,
                is_tombstone, last_operation_id, canonical_hash, created_at, updated_at)
             VALUES ('tenant-1','branch-main','products','p9',1,'{}',0,'op0',
                     '0000000000000000000000000000000000000000000000000000000000000000','now','now')",
            [],
        )
        .unwrap();
        let report = run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        assert_eq!(report.applied, vec![11], "only the missing v0011 applies");
        assert_eq!(report.already_current, (1..=10).collect::<Vec<_>>());
        // v0010 data unchanged
        let rev: i64 = conn.query_row(
            "SELECT current_revision FROM canonical_entities WHERE record_id='p9'", [], |r| r.get(0)).unwrap();
        assert_eq!(rev, 1);
        // re-run is idempotent (nothing re-applied)
        let again = run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        assert!(again.applied.is_empty());
        assert_eq!(again.already_current, (1..=11).collect::<Vec<_>>());
        // desktop business tables untouched
        assert_eq!(cnt(&conn, "products"), 0);
    }
}
