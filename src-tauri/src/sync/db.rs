use rusqlite::{Connection, Result};
use std::path::Path;

/// M6-B1 — stable id of the desktop host's system principal.
///
/// The embedded server mints a self-token with `sub = "self-desktop"`
/// (`SyncServer::start`), and that subject lands in `sync_changelog.user_id`.
/// `sync_changelog` has no foreign keys, so the missing `users` row never
/// surfaced — but `operations.actor_id` REFERENCES `users(id)` and the embedded
/// server runs with `PRAGMA foreign_keys=ON`, so without this row every future
/// operation written under the self-token would fail the FK.
pub const SYSTEM_PRINCIPAL_ID: &str = "self-desktop";
const SYSTEM_PRINCIPAL_EMAIL: &str = "system@lataif.local";
/// Not a bcrypt hash. `bcrypt::verify` returns `Err` on a malformed hash and
/// `login` does `.unwrap_or(false)`, so no password can ever match. This is the
/// third independent guard behind `active = 0` and "no default branch".
const SYSTEM_PRINCIPAL_UNUSABLE_HASH: &str = "!";

pub fn init_database(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;
    conn.execute_batch("PRAGMA foreign_keys=ON;")?;

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS tenants (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            plan TEXT DEFAULT 'starter',
            active INTEGER DEFAULT 1,
            max_branches INTEGER DEFAULT 3,
            max_users INTEGER DEFAULT 10,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS branches (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id),
            name TEXT NOT NULL,
            country TEXT DEFAULT 'BH',
            currency TEXT DEFAULT 'BHD',
            address TEXT,
            active INTEGER DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id),
            email TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            name TEXT NOT NULL,
            active INTEGER DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(tenant_id, email)
        );

        CREATE TABLE IF NOT EXISTS user_branches (
            user_id TEXT NOT NULL REFERENCES users(id),
            branch_id TEXT NOT NULL REFERENCES branches(id),
            role TEXT NOT NULL DEFAULT 'viewer',
            is_default INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            PRIMARY KEY (user_id, branch_id)
        );

        CREATE TABLE IF NOT EXISTS sync_changelog (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT NOT NULL,
            branch_id TEXT NOT NULL,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            action TEXT NOT NULL,
            data TEXT NOT NULL,
            user_id TEXT,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_sync_tenant_branch ON sync_changelog(tenant_id, branch_id);
        CREATE INDEX IF NOT EXISTS idx_sync_id ON sync_changelog(id);
        ",
    )?;

    // Seed default tenant + owner user if database is empty
    let tenant_count: i64 = conn.query_row("SELECT COUNT(*) FROM tenants", [], |r| r.get(0))?;
    if tenant_count == 0 {
        let now = chrono::Utc::now().to_rfc3339();
        let tenant_id = "tenant-1";
        let branch_id = "branch-main";
        let user_id = "user-owner";
        let default_password = bcrypt::hash("admin", 10).unwrap_or_default();

        conn.execute(
            "INSERT INTO tenants (id, name, slug, plan, active, created_at, updated_at) VALUES (?1, 'My Business', 'mybiz', 'enterprise', 1, ?2, ?2)",
            rusqlite::params![tenant_id, now],
        )?;
        conn.execute(
            "INSERT INTO branches (id, tenant_id, name, country, currency, active, created_at, updated_at) VALUES (?1, ?2, 'Main Branch', 'BH', 'BHD', 1, ?3, ?3)",
            rusqlite::params![branch_id, tenant_id, now],
        )?;
        conn.execute(
            "INSERT INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at) VALUES (?1, ?2, 'admin@lataif.com', ?3, 'Admin', 1, ?4, ?4)",
            rusqlite::params![user_id, tenant_id, default_password, now],
        )?;
        conn.execute(
            "INSERT INTO user_branches (user_id, branch_id, role, is_default, created_at) VALUES (?1, ?2, 'owner', 1, ?3)",
            rusqlite::params![user_id, branch_id, now],
        )?;
    }

    // M6-B1 — additive, INACTIVE protocol foundation. Runs AFTER the base schema
    // exists (the migration ALTERs sync_changelog). Everything it creates stays
    // empty and unread: no CAS, no authority, no bootstrap, no snapshot.
    // The runner is the shared core from the server library — not a second copy.
    lataif_server::migrations::run_migrations(&conn, super::migrations::EMBEDDED_MIGRATIONS)
        .map_err(|e| {
            rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
                Some(format!("embedded sync migration failed: {e:?}")),
            )
        })?;

    // M6-B1 — the system principal must exist before any operation can reference
    // it. Idempotent and independent of the seed block above (which only runs on
    // a virgin DB) so existing installs get it too.
    seed_system_principal(&conn)?;

    Ok(conn)
}

/// Seed the `self-desktop` system principal. Idempotent (`INSERT OR IGNORE` on the
/// primary key) and non-destructive: an existing row — including a user's own — is
/// never modified.
///
/// The principal is deliberately unusable for login, guarded three times over:
///  1. `active = 0`      → `login` filters `WHERE u.active = 1`
///  2. no `user_branches` row with `is_default = 1` → `login`'s INNER JOIN drops it
///  3. non-bcrypt password hash → `bcrypt::verify` errs → `.unwrap_or(false)`
///
/// It is granted `role = 'system'` on the main branch (never `owner`), which is
/// where this schema keeps roles, so audit can tell host-server writes apart from
/// a real person's. `is_default = 0` keeps guard 2 intact.
///
/// Tied to `tenant-1` / `branch-main` because that is exactly what the self-token
/// claims (`SyncServer::start`). On a DB registered via `/auth/register` those ids
/// do not exist — then the self-token would not authenticate either, so the seed
/// is skipped rather than inventing a principal in a foreign tenant.
pub fn seed_system_principal(conn: &Connection) -> Result<()> {
    let tenant_exists: i64 =
        conn.query_row("SELECT COUNT(*) FROM tenants WHERE id = 'tenant-1'", [], |r| r.get(0))?;
    if tenant_exists == 0 {
        return Ok(());
    }
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT OR IGNORE INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at)
         VALUES (?1, 'tenant-1', ?2, ?3, 'System (Desktop Host)', 0, ?4, ?4)",
        rusqlite::params![
            SYSTEM_PRINCIPAL_ID,
            SYSTEM_PRINCIPAL_EMAIL,
            SYSTEM_PRINCIPAL_UNUSABLE_HASH,
            now
        ],
    )?;

    let branch_exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM branches WHERE id = 'branch-main'",
        [],
        |r| r.get(0),
    )?;
    if branch_exists > 0 {
        conn.execute(
            "INSERT OR IGNORE INTO user_branches (user_id, branch_id, role, is_default, created_at)
             VALUES (?1, 'branch-main', 'system', 0, ?2)",
            rusqlite::params![SYSTEM_PRINCIPAL_ID, now],
        )?;
    }

    Ok(())
}

#[cfg(test)]
mod system_principal_tests {
    use super::*;
    use lataif_server::migrations::run_migrations;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute_batch(
            "
            CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
                plan TEXT, active INTEGER DEFAULT 1, max_branches INTEGER, max_users INTEGER,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
                name TEXT NOT NULL, country TEXT, currency TEXT, address TEXT, active INTEGER DEFAULT 1,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
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
            INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES ('tenant-1','T','t','n','n');
            INSERT INTO branches (id, tenant_id, name, created_at, updated_at)
                VALUES ('branch-main','tenant-1','B','n','n');
            INSERT INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at)
                VALUES ('user-owner','tenant-1','admin@lataif.com','$2b$10$realhash','Admin',1,'n','n');
            INSERT INTO user_branches (user_id, branch_id, role, is_default, created_at)
                VALUES ('user-owner','branch-main','owner',1,'n');
            ",
        )
        .unwrap();
        conn
    }

    /// Mirrors `routes::login`'s lookup exactly — the real gate we must stay behind.
    fn login_candidate(conn: &Connection, email: &str) -> Option<String> {
        conn.query_row(
            "SELECT u.id FROM users u
             JOIN user_branches ub ON ub.user_id = u.id AND ub.is_default = 1
             JOIN branches b ON b.id = ub.branch_id
             WHERE u.email = ?1 AND u.active = 1",
            [email],
            |r| r.get::<_, String>(0),
        )
        .ok()
    }

    #[test]
    fn seed_is_idempotent() {
        let conn = db();
        seed_system_principal(&conn).unwrap();
        seed_system_principal(&conn).unwrap();
        seed_system_principal(&conn).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM users WHERE id = ?1", [SYSTEM_PRINCIPAL_ID], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "three seed runs must leave exactly one row");
        let b: i64 = conn
            .query_row("SELECT COUNT(*) FROM user_branches WHERE user_id = ?1", [SYSTEM_PRINCIPAL_ID], |r| r.get(0))
            .unwrap();
        assert_eq!(b, 1);
    }

    #[test]
    fn existing_users_are_untouched() {
        let conn = db();
        let before: (String, String, i64) = conn
            .query_row("SELECT email, password_hash, active FROM users WHERE id='user-owner'", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        seed_system_principal(&conn).unwrap();
        let after: (String, String, i64) = conn
            .query_row("SELECT email, password_hash, active FROM users WHERE id='user-owner'", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(before, after);
        assert!(login_candidate(&conn, "admin@lataif.com").is_some(), "real owner still logs in");
    }

    #[test]
    fn login_is_impossible_for_the_system_principal() {
        let conn = db();
        seed_system_principal(&conn).unwrap();

        // Guard 1: active = 0
        let active: i64 = conn
            .query_row("SELECT active FROM users WHERE id = ?1", [SYSTEM_PRINCIPAL_ID], |r| r.get(0))
            .unwrap();
        assert_eq!(active, 0);

        // Guard 2: no default branch → login's INNER JOIN drops it
        let is_default: i64 = conn
            .query_row("SELECT is_default FROM user_branches WHERE user_id = ?1", [SYSTEM_PRINCIPAL_ID], |r| r.get(0))
            .unwrap();
        assert_eq!(is_default, 0);

        // Guard 3: hash is not bcrypt → verify errs → unwrap_or(false)
        let hash: String = conn
            .query_row("SELECT password_hash FROM users WHERE id = ?1", [SYSTEM_PRINCIPAL_ID], |r| r.get(0))
            .unwrap();
        assert!(!hash.starts_with("$2"), "must not be a valid bcrypt hash");
        assert!(!bcrypt::verify("admin", &hash).unwrap_or(false));
        assert!(!bcrypt::verify("", &hash).unwrap_or(false));

        // The real query login runs finds nothing.
        assert!(login_candidate(&conn, SYSTEM_PRINCIPAL_EMAIL).is_none());
    }

    #[test]
    fn system_principal_has_no_owner_rights() {
        let conn = db();
        seed_system_principal(&conn).unwrap();
        let role: String = conn
            .query_row("SELECT role FROM user_branches WHERE user_id = ?1", [SYSTEM_PRINCIPAL_ID], |r| r.get(0))
            .unwrap();
        assert_eq!(role, "system");
        assert_ne!(role, "owner");
    }

    #[test]
    fn operations_fk_accepts_the_principal_and_rejects_unknown_actors() {
        let conn = db();
        run_migrations(&conn, super::super::migrations::EMBEDDED_MIGRATIONS).unwrap();
        seed_system_principal(&conn).unwrap();

        let insert = |actor: &str| {
            conn.execute(
                "INSERT INTO operations (tenant_id, operation_id, branch_id, client_id, actor_id,
                    table_name, record_id, base_revision, payload_hash, protocol_version, status,
                    result_json, created_at)
                 VALUES ('tenant-1', ?1, 'branch-main', 'dev-1', ?2, 'products', 'p1', 1,
                    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 4,
                    'accepted', '{}', 'now')",
                rusqlite::params![format!("op-{actor}"), actor],
            )
        };

        assert!(insert(SYSTEM_PRINCIPAL_ID).is_ok(), "self-desktop must satisfy the actor FK");
        assert!(insert("user-owner").is_ok(), "a real user must still work");
        assert!(insert("ghost-user").is_err(), "unknown actor_id must still be rejected by the FK");
    }

    // ── The REAL init_database() against a throwaway file ───────────────────
    //
    // The `db()` helper above mirrors the production schema by hand; if it ever
    // drifts from `init_database`, these tests would stay green while reality
    // breaks. This test drives the actual production path end-to-end on a temp
    // file — no live AppData, no app launch, isolated per run.
    fn tmp_db_path() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "com.lataif.m6b1test20260716-{}",
            uuid::Uuid::new_v4().as_simple()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d.join("lataif_sync_server.db")
    }

    #[test]
    fn real_init_database_migrates_seeds_and_is_idempotent() {
        let path = tmp_db_path();

        // First start: virgin DB → base schema + seed + migration + principal.
        let conn = init_database(&path).unwrap();
        for t in [
            "tenants", "branches", "users", "user_branches", "sync_changelog",
            "canonical_records", "operations", "schema_migrations",
        ] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [t],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "{t} must exist after real init_database");
        }
        // Inactive foundation: created but empty.
        for t in ["canonical_records", "operations"] {
            let n: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "{t} must be empty");
        }
        // Principal present and unusable.
        let (active, hash): (i64, String) = conn
            .query_row(
                "SELECT active, password_hash FROM users WHERE id = ?1",
                [SYSTEM_PRINCIPAL_ID],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(active, 0);
        assert!(!bcrypt::verify("admin", &hash).unwrap_or(false));
        assert!(login_candidate(&conn, SYSTEM_PRINCIPAL_EMAIL).is_none());
        // The real owner seeded by the legacy block still logs in.
        assert!(login_candidate(&conn, "admin@lataif.com").is_some());
        drop(conn);

        // Second start on the SAME file: migration is a verified no-op, seed
        // stays single, nothing is duplicated.
        let conn2 = init_database(&path).unwrap();
        let principals: i64 = conn2
            .query_row("SELECT COUNT(*) FROM users WHERE id = ?1", [SYSTEM_PRINCIPAL_ID], |r| r.get(0))
            .unwrap();
        assert_eq!(principals, 1, "restart must not duplicate the principal");
        let tenants: i64 = conn2.query_row("SELECT COUNT(*) FROM tenants", [], |r| r.get(0)).unwrap();
        assert_eq!(tenants, 1, "restart must not re-seed the tenant");
        let applied: i64 = conn2
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            applied,
            super::super::migrations::EMBEDDED_MIGRATIONS.len() as i64,
            "each migration recorded exactly once after two starts"
        );
        drop(conn2);

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn real_init_database_preserves_pre_existing_changelog_rows() {
        let path = tmp_db_path();
        {
            let conn = init_database(&path).unwrap();
            conn.execute(
                "INSERT INTO sync_changelog (tenant_id, branch_id, table_name, record_id, action, data, user_id, created_at)
                 VALUES ('tenant-1','branch-main','products','p1','update','{\"brand\":\"X\"}','self-desktop','2026-01-01')",
                [],
            )
            .unwrap();
        }
        // Restart: the row must read back byte-identical, new columns NULL.
        let conn = init_database(&path).unwrap();
        let (data, user, rev, op, pv): (String, String, Option<i64>, Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT data, user_id, record_revision, operation_id, protocol_version
                 FROM sync_changelog WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(data, "{\"brand\":\"X\"}");
        assert_eq!(user, "self-desktop");
        assert!(rev.is_none() && op.is_none() && pv.is_none(), "no invented backfill");
        drop(conn);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn seed_is_skipped_when_tenant_1_is_absent() {
        let conn = db();
        conn.execute_batch("DELETE FROM user_branches; DELETE FROM users; DELETE FROM branches; DELETE FROM tenants;")
            .unwrap();
        seed_system_principal(&conn).unwrap(); // must not error
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "no principal invented in a foreign/empty tenant");
    }
}
