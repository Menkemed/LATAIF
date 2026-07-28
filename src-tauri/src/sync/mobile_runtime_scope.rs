// MOBILE-04B2A3 — canonical runtime-scope binding SSOT.
//
// The mobile upload pipeline needs ONE trusted runtime source of its (tenant_id, branch_id) scope.
// The fixed compile-time constants ("tenant-1"/"branch-main") are NOT that source — they are seed
// values, and a real deployment's branch id can diverge. This module is the only trusted source: an
// EXPLICIT, owner-configured binding of (tenant_id, branch_id) to THIS install (server_instance_id =
// the install id), stored server-side in `mobile_runtime_scope` (v0014), and the `RuntimeScopeEvidence`
// the JS gate checks against the active auth/DB scope.
//
// Invariants:
//   * only an authorized owner can configure it (the core takes a verified `OwnerAuth`, which only
//     `authorize_owner` can mint — no caller can vouch for itself);
//   * the (tenant, branch) must exist in the server DB and belong together;
//   * exactly one ACTIVE binding per install (a partial unique index enforces it);
//   * NO automatic first-writer / first-login binding — a binding appears only from an explicit call;
//   * changing the binding is an explicit operation that supersedes the prior active row and bumps
//     `binding_revision` (history is preserved as the audit trail);
//   * the binding is INTERNAL / never synced.
//
// The read path is safe to expose (it reveals only the configured scope, or `configured=false`); the
// configure path is owner-gated and, in this slice, not wired to any IPC command or UI, so no binding
// can be created at runtime and the pipeline stays blocked.

use rusqlite::{params, Connection, OptionalExtension};

use super::primary::OwnerAuth;

/// The scope binding evidence Rust hands to the JS gate. `configured=false` (with empty
/// tenant/branch and revision 0) means "no active binding" → the gate must stay closed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeScopeEvidence {
    pub tenant_id: String,
    pub branch_id: String,
    pub server_instance_id: String,
    pub binding_revision: i64,
    pub configured: bool,
}

// Error codes (stable strings; surfaced verbatim to the caller/tests).
pub const ERR_SCOPE_BRANCH_UNKNOWN: &str = "MOBILE_SCOPE_BRANCH_UNKNOWN";
pub const ERR_SCOPE_TENANT_MISMATCH: &str = "MOBILE_SCOPE_BRANCH_TENANT_MISMATCH";
pub const ERR_SCOPE_TENANT_UNKNOWN: &str = "MOBILE_SCOPE_TENANT_UNKNOWN";
pub const ERR_SCOPE_EMPTY: &str = "MOBILE_SCOPE_EMPTY_IDENTIFIERS";
pub const ERR_SCOPE_DB: &str = "MOBILE_SCOPE_DB_ERROR";
/// MOBILE-04B2A3-R1 §3 — a mutation ran against a scope/revision that is no longer the SSOT truth.
pub const ERR_RUNTIME_SCOPE_REVISION_CONFLICT: &str = "MOBILE_RUNTIME_SCOPE_REVISION_CONFLICT";

/// Validate that (tenant_id, branch_id) is a real, self-consistent scope in the server DB. This is
/// what makes the binding trustworthy for arbitrary ids and forbids binding to a non-existent scope.
fn validate_scope(conn: &Connection, tenant_id: &str, branch_id: &str) -> Result<(), &'static str> {
    if tenant_id.is_empty() || branch_id.is_empty() {
        return Err(ERR_SCOPE_EMPTY);
    }
    let tenant_exists: bool = conn
        .query_row("SELECT 1 FROM tenants WHERE id = ?1", params![tenant_id], |_| Ok(()))
        .optional()
        .map_err(|_| ERR_SCOPE_DB)?
        .is_some();
    if !tenant_exists {
        return Err(ERR_SCOPE_TENANT_UNKNOWN);
    }
    let branch_tenant: Option<String> = conn
        .query_row("SELECT tenant_id FROM branches WHERE id = ?1", params![branch_id], |r| r.get(0))
        .optional()
        .map_err(|_| ERR_SCOPE_DB)?;
    match branch_tenant {
        None => Err(ERR_SCOPE_BRANCH_UNKNOWN),
        Some(t) if t != tenant_id => Err(ERR_SCOPE_TENANT_MISMATCH),
        Some(_) => Ok(()),
    }
}

/// Read the ACTIVE binding for this install as evidence. Never errors on "not configured": that is a
/// normal state that returns `configured=false`.
pub fn read_runtime_scope_evidence(
    conn: &Connection,
    server_instance_id: &str,
) -> Result<RuntimeScopeEvidence, &'static str> {
    let row: Option<(String, String, i64)> = conn
        .query_row(
            "SELECT tenant_id, branch_id, binding_revision
               FROM mobile_runtime_scope
              WHERE server_instance_id = ?1 AND status = 'active'",
            params![server_instance_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|_| ERR_SCOPE_DB)?;
    Ok(match row {
        Some((tenant_id, branch_id, binding_revision)) => RuntimeScopeEvidence {
            tenant_id,
            branch_id,
            server_instance_id: server_instance_id.to_string(),
            binding_revision,
            configured: true,
        },
        None => RuntimeScopeEvidence {
            tenant_id: String::new(),
            branch_id: String::new(),
            server_instance_id: server_instance_id.to_string(),
            binding_revision: 0,
            configured: false,
        },
    })
}

/// Configure (or explicitly rebind) the runtime scope for this install. Owner-gated by construction:
/// `owner` is a verified `OwnerAuth`. Idempotent for the SAME (tenant, branch) — it returns the
/// current active evidence without a new revision. A DIFFERENT (tenant, branch) supersedes the prior
/// active row and bumps `binding_revision`, so any worker fenced to the old revision is invalidated.
/// Atomic: validation + supersede + insert happen in one transaction.
pub fn configure_runtime_scope(
    conn: &mut Connection,
    server_instance_id: &str,
    tenant_id: &str,
    branch_id: &str,
    owner: &OwnerAuth,
    now: &str,
) -> Result<RuntimeScopeEvidence, &'static str> {
    validate_scope(conn, tenant_id, branch_id)?;

    // MOBILE-04B2A4 §2 — the rebind takes the SAME write contract as the mutations (BEGIN IMMEDIATE),
    // so it serializes against any in-flight fenced mutation: it cannot commit between a mutation's
    // fence-read and its write, and once it commits the old revision can never write again.
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| ERR_SCOPE_DB)?;

    let current: Option<(String, String, i64)> = tx
        .query_row(
            "SELECT tenant_id, branch_id, binding_revision
               FROM mobile_runtime_scope
              WHERE server_instance_id = ?1 AND status = 'active'",
            params![server_instance_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|_| ERR_SCOPE_DB)?;

    let next_revision = match &current {
        // Idempotent: an identical re-configuration is a no-op (same revision, no history churn).
        Some((t, b, _rev)) if t == tenant_id && b == branch_id => {
            tx.commit().map_err(|_| ERR_SCOPE_DB)?;
            return read_runtime_scope_evidence(conn, server_instance_id);
        }
        // Explicit rebind: supersede the prior active row (kept as audit history) and bump revision.
        Some((_, _, rev)) => {
            tx.execute(
                "UPDATE mobile_runtime_scope SET status = 'superseded'
                  WHERE server_instance_id = ?1 AND status = 'active'",
                params![server_instance_id],
            )
            .map_err(|_| ERR_SCOPE_DB)?;
            rev + 1
        }
        None => 1,
    };

    tx.execute(
        "INSERT INTO mobile_runtime_scope
           (server_instance_id, binding_revision, tenant_id, branch_id, configured_by, configured_at, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active')",
        params![server_instance_id, next_revision, tenant_id, branch_id, owner.user_id(), now],
    )
    .map_err(|_| ERR_SCOPE_DB)?;

    tx.commit().map_err(|_| ERR_SCOPE_DB)?;
    read_runtime_scope_evidence(conn, server_instance_id)
}

/// MOBILE-04B2A4 §1 — the caller's expected runtime scope, checked INSIDE a mutation's own IMMEDIATE
/// transaction (not a separate pre-SELECT), so a concurrent owner rebind is serialized against it.
#[derive(Debug, Clone)]
pub struct RuntimeScopeExpectation {
    pub server_instance_id: String,
    pub binding_revision: i64,
    pub tenant_id: String,
    pub branch_id: String,
}

/// MOBILE-04B2A3-R1 §3 — the SERVER-SIDE revision fence every internal mobile MUTATION must pass
/// before it opens the DB/files or writes. It reads the CURRENT active binding itself (the SSOT) and
/// requires the caller's expectation to match it EXACTLY — install-derived `server_instance_id`, the
/// current `binding_revision`, and the (tenant, branch). A stale worker (holding an old revision) or a
/// scope drift is refused with `ERR_RUNTIME_SCOPE_REVISION_CONFLICT`, so a JS-side check is never the
/// only line of defence. No active binding at all → conflict (fail closed).
pub fn fence_runtime_scope(
    conn: &Connection,
    server_instance_id: &str,
    expected_revision: i64,
    expected_tenant_id: &str,
    expected_branch_id: &str,
) -> Result<(), &'static str> {
    let ev = read_runtime_scope_evidence(conn, server_instance_id)?;
    if !ev.configured {
        return Err(ERR_RUNTIME_SCOPE_REVISION_CONFLICT);
    }
    if ev.binding_revision != expected_revision
        || ev.tenant_id != expected_tenant_id
        || ev.branch_id != expected_branch_id
    {
        return Err(ERR_RUNTIME_SCOPE_REVISION_CONFLICT);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::{credentials, migrations, primary};
    use rusqlite::Connection;

    const PW: &str = "correct-horse-battery";

    fn seed(conn: &Connection) {
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute_batch(SEED_SQL).unwrap();
        lataif_server::migrations::run_migrations(conn, migrations::EMBEDDED_MIGRATIONS).unwrap();
        credentials::provision_owner(conn, PW, PW, credentials::PROVISION_CONFIRMATION).unwrap();
    }

    // A DB with the base schema, all migrations, a provisioned owner (tenant-1/branch-main), plus a
    // SECOND, non-default tenant with a UUID branch — to prove the binding is scope-value-agnostic.
    fn env() -> (Connection, OwnerAuth) {
        let conn = Connection::open_in_memory().unwrap();
        seed(&conn);
        let owner = primary::authorize_owner(&conn, "tenant-1", "branch-main", "a@b.c", PW).unwrap();
        (conn, owner)
    }

    // MOBILE-04B2A4 §2 — a FILE-backed DB so two independent connections can contend for the write
    // lock. Returns the dir so the caller can open a second connection to the same DB.
    fn env_file() -> (Connection, OwnerAuth, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("lataif_scope_{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(dir.join("server.db")).unwrap();
        conn.busy_timeout(std::time::Duration::from_secs(10)).unwrap();
        seed(&conn);
        let owner = primary::authorize_owner(&conn, "tenant-1", "branch-main", "a@b.c", PW).unwrap();
        (conn, owner, dir)
    }

    const SEED_SQL: &str =
            "
            CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
                plan TEXT DEFAULT 'starter', active INTEGER DEFAULT 1, max_branches INTEGER DEFAULT 3,
                max_users INTEGER DEFAULT 10, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
                name TEXT NOT NULL, country TEXT DEFAULT 'BH', currency TEXT DEFAULT 'BHD',
                address TEXT, active INTEGER DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
                email TEXT NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL,
                active INTEGER DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                UNIQUE(tenant_id, email));
            CREATE TABLE user_branches (user_id TEXT NOT NULL REFERENCES users(id),
                branch_id TEXT NOT NULL REFERENCES branches(id), role TEXT NOT NULL DEFAULT 'viewer',
                is_default INTEGER DEFAULT 0, created_at TEXT NOT NULL, PRIMARY KEY (user_id, branch_id));
            CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
                branch_id TEXT NOT NULL, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
                action TEXT NOT NULL, data TEXT NOT NULL, user_id TEXT, created_at TEXT NOT NULL);
            INSERT INTO tenants (id,name,slug,created_at,updated_at) VALUES ('tenant-1','T','t','now','now');
            INSERT INTO branches (id,tenant_id,name,created_at,updated_at) VALUES ('branch-main','tenant-1','B','now','now');
            INSERT INTO users (id,tenant_id,email,password_hash,name,created_at,updated_at)
                VALUES ('user-owner','tenant-1','a@b.c','x','Admin','now','now');
            INSERT INTO user_branches (user_id,branch_id,role,is_default,created_at)
                VALUES ('user-owner','branch-main','owner',1,'now');
            -- a non-default tenant + a UUID branch (the id shape a real multi-branch deployment uses)
            INSERT INTO tenants (id,name,slug,created_at,updated_at) VALUES ('tenant-acme','Acme','acme','now','now');
            INSERT INTO branches (id,tenant_id,name,created_at,updated_at)
                VALUES ('b2b1f6a4-3c2e-4f1a-9d7c-0a1b2c3d4e5f','tenant-acme','Acme HQ','now','now');
            ";

    const INST: &str = "install-abc";
    const UUID_BRANCH: &str = "b2b1f6a4-3c2e-4f1a-9d7c-0a1b2c3d4e5f";

    #[test]
    fn unconfigured_reads_as_not_configured() {
        let (conn, _owner) = env();
        let ev = read_runtime_scope_evidence(&conn, INST).unwrap();
        assert!(!ev.configured);
        assert_eq!(ev.binding_revision, 0);
        assert!(ev.tenant_id.is_empty() && ev.branch_id.is_empty());
    }

    #[test]
    fn configures_non_default_tenant_and_uuid_branch() {
        let (mut conn, owner) = env();
        let ev = configure_runtime_scope(&mut conn, INST, "tenant-acme", UUID_BRANCH, &owner, "t0").unwrap();
        assert!(ev.configured);
        assert_eq!(ev.tenant_id, "tenant-acme");
        assert_eq!(ev.branch_id, UUID_BRANCH);
        assert_eq!(ev.binding_revision, 1);
        // read-back is identical evidence
        assert_eq!(read_runtime_scope_evidence(&conn, INST).unwrap(), ev);
    }

    #[test]
    fn unknown_branch_is_rejected() {
        let (mut conn, owner) = env();
        let e = configure_runtime_scope(&mut conn, INST, "tenant-1", "no-such-branch", &owner, "t0").unwrap_err();
        assert_eq!(e, ERR_SCOPE_BRANCH_UNKNOWN);
        assert!(!read_runtime_scope_evidence(&conn, INST).unwrap().configured, "nothing bound on rejection");
    }

    #[test]
    fn unknown_tenant_is_rejected() {
        let (mut conn, owner) = env();
        let e = configure_runtime_scope(&mut conn, INST, "tenant-ghost", UUID_BRANCH, &owner, "t0").unwrap_err();
        assert_eq!(e, ERR_SCOPE_TENANT_UNKNOWN);
    }

    #[test]
    fn branch_of_another_tenant_is_rejected() {
        let (mut conn, owner) = env();
        // branch-main belongs to tenant-1, not tenant-acme.
        let e = configure_runtime_scope(&mut conn, INST, "tenant-acme", "branch-main", &owner, "t0").unwrap_err();
        assert_eq!(e, ERR_SCOPE_TENANT_MISMATCH);
    }

    #[test]
    fn same_binding_is_idempotent_no_revision_bump() {
        let (mut conn, owner) = env();
        let a = configure_runtime_scope(&mut conn, INST, "tenant-acme", UUID_BRANCH, &owner, "t0").unwrap();
        let b = configure_runtime_scope(&mut conn, INST, "tenant-acme", UUID_BRANCH, &owner, "t1").unwrap();
        assert_eq!(a, b, "same scope → same revision, idempotent");
        assert_eq!(b.binding_revision, 1);
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM mobile_runtime_scope WHERE server_instance_id=?1", params![INST], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "no history churn on an identical re-configure");
    }

    #[test]
    fn rebind_bumps_revision_and_supersedes_prior() {
        let (mut conn, owner) = env();
        configure_runtime_scope(&mut conn, INST, "tenant-acme", UUID_BRANCH, &owner, "t0").unwrap();
        let rebound = configure_runtime_scope(&mut conn, INST, "tenant-1", "branch-main", &owner, "t1").unwrap();
        assert_eq!(rebound.binding_revision, 2, "explicit rebind bumps the revision (fences old workers)");
        assert_eq!(rebound.tenant_id, "tenant-1");
        // exactly one ACTIVE row; the prior binding is kept as superseded history.
        let active: i64 = conn.query_row("SELECT COUNT(*) FROM mobile_runtime_scope WHERE server_instance_id=?1 AND status='active'", params![INST], |r| r.get(0)).unwrap();
        let superseded: i64 = conn.query_row("SELECT COUNT(*) FROM mobile_runtime_scope WHERE server_instance_id=?1 AND status='superseded'", params![INST], |r| r.get(0)).unwrap();
        assert_eq!(active, 1);
        assert_eq!(superseded, 1);
    }

    #[test]
    fn binding_survives_reopen_identically() {
        // The binding is durable — a fresh connection to the same DB sees identical evidence. (We use
        // one in-memory DB the whole test; the point is that read is a plain query with no cache.)
        let (mut conn, owner) = env();
        let before = configure_runtime_scope(&mut conn, INST, "tenant-acme", UUID_BRANCH, &owner, "t0").unwrap();
        let after = read_runtime_scope_evidence(&conn, INST).unwrap();
        assert_eq!(before, after, "restart-stable: same revision, tenant, branch");
        assert_eq!(after.binding_revision, 1);
    }

    #[test]
    fn two_installs_bind_independently() {
        let (mut conn, owner) = env();
        configure_runtime_scope(&mut conn, "install-A", "tenant-1", "branch-main", &owner, "t0").unwrap();
        configure_runtime_scope(&mut conn, "install-B", "tenant-acme", UUID_BRANCH, &owner, "t0").unwrap();
        assert_eq!(read_runtime_scope_evidence(&conn, "install-A").unwrap().tenant_id, "tenant-1");
        assert_eq!(read_runtime_scope_evidence(&conn, "install-B").unwrap().tenant_id, "tenant-acme");
    }

    // ── §4 — configured_by comes from the verified owner, never a caller-supplied name ──
    #[test]
    fn configured_by_is_the_verified_owner() {
        let (mut conn, owner) = env();
        configure_runtime_scope(&mut conn, INST, "tenant-acme", UUID_BRANCH, &owner, "t0").unwrap();
        let by: String = conn.query_row(
            "SELECT configured_by FROM mobile_runtime_scope WHERE server_instance_id=?1 AND status='active'",
            params![INST], |r| r.get(0)).unwrap();
        assert_eq!(by, owner.user_id(), "configured_by is the TrustedOwnerContext identity");
        assert_eq!(by, "user-owner");
    }

    // ── §1 — a superseded (inactive) binding reads as NOT configured ──
    #[test]
    fn superseded_binding_reads_as_unconfigured() {
        let (mut conn, owner) = env();
        configure_runtime_scope(&mut conn, INST, "tenant-acme", UUID_BRANCH, &owner, "t0").unwrap();
        configure_runtime_scope(&mut conn, INST, "tenant-1", "branch-main", &owner, "t1").unwrap(); // rebind
        // The superseded revision-1 row still exists but is never the evidence.
        let ev = read_runtime_scope_evidence(&conn, INST).unwrap();
        assert!(ev.configured && ev.binding_revision == 2 && ev.tenant_id == "tenant-1");
    }

    // ── §3 — the server-side revision fence ──
    #[test]
    fn fence_passes_only_on_the_exact_current_binding() {
        let (mut conn, owner) = env();
        configure_runtime_scope(&mut conn, INST, "tenant-acme", UUID_BRANCH, &owner, "t0").unwrap();
        // exact match → ok
        assert!(fence_runtime_scope(&conn, INST, 1, "tenant-acme", UUID_BRANCH).is_ok());
        // stale revision → conflict
        assert_eq!(fence_runtime_scope(&conn, INST, 2, "tenant-acme", UUID_BRANCH).unwrap_err(), ERR_RUNTIME_SCOPE_REVISION_CONFLICT);
        // wrong tenant / branch → conflict
        assert_eq!(fence_runtime_scope(&conn, INST, 1, "tenant-1", UUID_BRANCH).unwrap_err(), ERR_RUNTIME_SCOPE_REVISION_CONFLICT);
        assert_eq!(fence_runtime_scope(&conn, INST, 1, "tenant-acme", "branch-main").unwrap_err(), ERR_RUNTIME_SCOPE_REVISION_CONFLICT);
        // unknown install / no binding → conflict (fail closed)
        assert_eq!(fence_runtime_scope(&conn, "other-install", 1, "tenant-acme", UUID_BRANCH).unwrap_err(), ERR_RUNTIME_SCOPE_REVISION_CONFLICT);
    }

    #[test]
    fn fence_follows_a_rebind_to_the_new_revision() {
        let (mut conn, owner) = env();
        configure_runtime_scope(&mut conn, INST, "tenant-acme", UUID_BRANCH, &owner, "t0").unwrap();
        configure_runtime_scope(&mut conn, INST, "tenant-1", "branch-main", &owner, "t1").unwrap(); // → revision 2
        // the old revision no longer fences through
        assert_eq!(fence_runtime_scope(&conn, INST, 1, "tenant-acme", UUID_BRANCH).unwrap_err(), ERR_RUNTIME_SCOPE_REVISION_CONFLICT);
        // only the new binding does
        assert!(fence_runtime_scope(&conn, INST, 2, "tenant-1", "branch-main").is_ok());
    }

    // MOBILE-04B2A4 §2 — the real owner rebind uses BEGIN IMMEDIATE (the SAME write contract as the
    // mutations), so it cannot commit while another connection holds the write lock. Proven on a
    // file-backed DB: with a mutation's IMMEDIATE tx open on conn1, a rebind on conn2 (no wait) fails
    // closed rather than slipping in.
    #[test]
    fn configure_takes_the_immediate_write_lock() {
        let (mut c1, owner, dir) = env_file();
        configure_runtime_scope(&mut c1, INST, "tenant-1", "branch-main", &owner, "t0").unwrap();
        // conn1 holds the write lock (a stand-in for an in-flight fenced mutation).
        let held = c1.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).unwrap();
        // conn2 attempts the real rebind without waiting.
        let mut c2 = Connection::open(dir.join("server.db")).unwrap();
        c2.busy_timeout(std::time::Duration::from_millis(0)).unwrap();
        let owner2 = primary::authorize_owner(&c2, "tenant-1", "branch-main", "a@b.c", PW).unwrap();
        let r = configure_runtime_scope(&mut c2, INST, "tenant-acme", UUID_BRANCH, &owner2, "t1");
        assert_eq!(r.unwrap_err(), ERR_SCOPE_DB, "rebind cannot commit while a mutation holds IMMEDIATE");
        // once the mutation releases, the rebind proceeds and the revision advances monotonically.
        held.commit().unwrap();
        c2.busy_timeout(std::time::Duration::from_secs(10)).unwrap();
        let ev = configure_runtime_scope(&mut c2, INST, "tenant-acme", UUID_BRANCH, &owner2, "t2").unwrap();
        assert_eq!(ev.binding_revision, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
