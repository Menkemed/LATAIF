use rusqlite::{Connection, Result};

pub fn init_database() -> Result<Connection> {
    let db_path = std::env::var("DATABASE_PATH").unwrap_or_else(|_| "lataif_server.db".to_string());
    let conn = Connection::open(&db_path)?;

    conn.execute_batch("PRAGMA journal_mode=WAL;")?;
    conn.execute_batch("PRAGMA foreign_keys=ON;")?;

    // Server-side schema — mirrors the client schema + sync tables
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

        -- Sync changelog — all data changes from all clients
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

    tracing::info!("Database initialized at {}", db_path);
    Ok(conn)
}
