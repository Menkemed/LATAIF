use rusqlite::{Connection, Result};
use std::path::Path;

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
        "
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

    Ok(conn)
}
