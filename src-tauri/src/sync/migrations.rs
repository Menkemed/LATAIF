//! M6-B1 — Additive, INACTIVE migrations for the EMBEDDED sync server DB.
//!
//! ## Scope (inactive foundation only)
//!
//! This module owns the embedded server's migration list. The runner itself is
//! NOT reimplemented here — it is the shared core from the server library
//! (`lataif_server::migrations::run_migrations`), which takes the migration list
//! as a parameter. One implementation of the versioning / checksum / drift rules,
//! two independent lists.
//!
//! The migration is purely additive and everything it creates stays **empty and
//! unread**:
//! - `canonical_records` and `operations` are created but no production path
//!   reads or writes them; there is no CAS, no authority, no bootstrap.
//! - `sync_changelog` gains three NULLable columns; existing rows keep every
//!   value they had and are never backfilled with invented revisions.
//! - `tenants` / `branches` / `users` / `user_branches` are untouched.
//!
//! ## Why `up_sql != reference_sql` here
//!
//! The shared runner builds its structural drift reference by executing
//! `reference_sql` in a throwaway **empty** in-memory database. An
//! `ALTER TABLE sync_changelog …` cannot run there (the table does not exist),
//! and matching SQLite's rewritten `sqlite_master` text for an ALTERed table
//! would be brittle. So `reference_sql` declares only the two NEW tables — they
//! are the structures worth drift-checking — while `up_sql` additionally carries
//! the three additive column adds. The adds are still applied exactly once,
//! because `schema_migrations` gates the whole migration by version.
//!
//! ## Deliberately NOT in this migration
//!
//! - `authority_epoch` on `operations`: the authority contract is not settled
//!   (M6-A4 established that single-authority is not enforceable without a
//!   shared lease). Adding the column now would imply a guarantee that does not
//!   exist. M6-B2 adds it together with the mechanism that gives it meaning.
//! - Snapshot/bootstrap tables: M6-B4.
//! - Any row insert: a migration never seeds business data (the system principal
//!   is seeded separately and idempotently in `db.rs`).

use lataif_server::migrations::Migration;

/// The embedded server's migrations, strictly ascending. Independent from the
/// standalone server's `ALL_MIGRATIONS` — different deployment, different scope.
pub const EMBEDDED_MIGRATIONS: &[Migration] = &[V0001_SYNC_PROTOCOL_FOUNDATION];

pub const V0001_SYNC_PROTOCOL_FOUNDATION: Migration = Migration {
    version: 1,
    name: "sync_protocol_foundation",
    up_sql: UP_SQL,
    reference_sql: REFERENCE_SQL,
};

/// Structural reference for drift detection: the two new tables only.
/// MUST stay byte-identical to the corresponding part of `UP_SQL` — asserted by
/// `tests::reference_sql_is_the_new_table_prefix_of_up_sql`.
const REFERENCE_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS canonical_records (
    tenant_id         TEXT NOT NULL,
    branch_id         TEXT NOT NULL,
    table_name        TEXT NOT NULL,
    record_id         TEXT NOT NULL,
    record_revision   INTEGER NOT NULL,
    deleted           INTEGER NOT NULL DEFAULT 0,
    data_json         TEXT NOT NULL,
    last_operation_id TEXT,
    updated_at        TEXT NOT NULL,

    PRIMARY KEY (tenant_id, branch_id, table_name, record_id),

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,

    CHECK (record_revision >= 1),
    CHECK (deleted IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_canonical_records_table
    ON canonical_records (tenant_id, branch_id, table_name);

CREATE TABLE IF NOT EXISTS operations (
    tenant_id        TEXT NOT NULL,
    operation_id     TEXT NOT NULL,
    branch_id        TEXT NOT NULL,
    client_id        TEXT,
    actor_id         TEXT NOT NULL,
    table_name       TEXT NOT NULL,
    record_id        TEXT NOT NULL,
    base_revision    INTEGER,
    payload_hash     TEXT NOT NULL,
    protocol_version INTEGER NOT NULL,
    status           TEXT NOT NULL,
    result_json      TEXT NOT NULL,
    created_at       TEXT NOT NULL,

    PRIMARY KEY (tenant_id, operation_id),

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE RESTRICT,

    CHECK (length(payload_hash) = 64),
    CHECK (protocol_version >= 1),
    CHECK (base_revision IS NULL OR base_revision >= 0),
    CHECK (status IN ('accepted', 'conflict', 'validation_rejected'))
);

CREATE INDEX IF NOT EXISTS idx_operations_record
    ON operations (tenant_id, branch_id, table_name, record_id);
"#;

/// Applied SQL: the reference structures plus the three additive, NULLable
/// protocol columns on the existing changelog. No backfill, no default value —
/// every pre-existing row reads back exactly as before, with NULL in the new
/// columns.
const UP_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS canonical_records (
    tenant_id         TEXT NOT NULL,
    branch_id         TEXT NOT NULL,
    table_name        TEXT NOT NULL,
    record_id         TEXT NOT NULL,
    record_revision   INTEGER NOT NULL,
    deleted           INTEGER NOT NULL DEFAULT 0,
    data_json         TEXT NOT NULL,
    last_operation_id TEXT,
    updated_at        TEXT NOT NULL,

    PRIMARY KEY (tenant_id, branch_id, table_name, record_id),

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,

    CHECK (record_revision >= 1),
    CHECK (deleted IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_canonical_records_table
    ON canonical_records (tenant_id, branch_id, table_name);

CREATE TABLE IF NOT EXISTS operations (
    tenant_id        TEXT NOT NULL,
    operation_id     TEXT NOT NULL,
    branch_id        TEXT NOT NULL,
    client_id        TEXT,
    actor_id         TEXT NOT NULL,
    table_name       TEXT NOT NULL,
    record_id        TEXT NOT NULL,
    base_revision    INTEGER,
    payload_hash     TEXT NOT NULL,
    protocol_version INTEGER NOT NULL,
    status           TEXT NOT NULL,
    result_json      TEXT NOT NULL,
    created_at       TEXT NOT NULL,

    PRIMARY KEY (tenant_id, operation_id),

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE RESTRICT,

    CHECK (length(payload_hash) = 64),
    CHECK (protocol_version >= 1),
    CHECK (base_revision IS NULL OR base_revision >= 0),
    CHECK (status IN ('accepted', 'conflict', 'validation_rejected'))
);

CREATE INDEX IF NOT EXISTS idx_operations_record
    ON operations (tenant_id, branch_id, table_name, record_id);

ALTER TABLE sync_changelog ADD COLUMN record_revision INTEGER;
ALTER TABLE sync_changelog ADD COLUMN operation_id TEXT;
ALTER TABLE sync_changelog ADD COLUMN protocol_version INTEGER;
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use lataif_server::migrations::run_migrations;
    use rusqlite::Connection;

    /// Minimal stand-in for the pre-existing embedded schema the migration lands on.
    /// Mirrors `db.rs` (tenants/branches/users/user_branches/sync_changelog).
    fn base_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS tenants (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
                plan TEXT DEFAULT 'starter', active INTEGER DEFAULT 1,
                max_branches INTEGER DEFAULT 3, max_users INTEGER DEFAULT 10,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS branches (
                id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
                name TEXT NOT NULL, country TEXT DEFAULT 'BH', currency TEXT DEFAULT 'BHD',
                address TEXT, active INTEGER DEFAULT 1,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
                email TEXT NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL,
                active INTEGER DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                UNIQUE(tenant_id, email)
            );
            CREATE TABLE IF NOT EXISTS user_branches (
                user_id TEXT NOT NULL REFERENCES users(id),
                branch_id TEXT NOT NULL REFERENCES branches(id),
                role TEXT NOT NULL DEFAULT 'viewer', is_default INTEGER DEFAULT 0,
                created_at TEXT NOT NULL, PRIMARY KEY (user_id, branch_id)
            );
            CREATE TABLE IF NOT EXISTS sync_changelog (
                id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
                branch_id TEXT NOT NULL, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
                action TEXT NOT NULL, data TEXT NOT NULL, user_id TEXT, created_at TEXT NOT NULL
            );
            INSERT INTO tenants (id, name, slug, created_at, updated_at)
                VALUES ('tenant-1', 'T', 't', 'now', 'now');
            INSERT INTO branches (id, tenant_id, name, created_at, updated_at)
                VALUES ('branch-main', 'tenant-1', 'B', 'now', 'now');
            INSERT INTO users (id, tenant_id, email, password_hash, name, created_at, updated_at)
                VALUES ('user-owner', 'tenant-1', 'a@b.c', 'h', 'Admin', 'now', 'now');
            ",
        )
        .unwrap();
        conn
    }

    fn legacy_row(conn: &Connection) {
        conn.execute(
            "INSERT INTO sync_changelog (tenant_id, branch_id, table_name, record_id, action, data, user_id, created_at)
             VALUES ('tenant-1','branch-main','products','p1','update','{\"brand\":\"X\"}','self-desktop','2026-01-01')",
            [],
        )
        .unwrap();
    }

    fn columns(conn: &Connection, table: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
            .unwrap();
        let v: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        v
    }

    fn table_exists(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
            > 0
    }

    // ── 1. Migration applies on a fresh embedded DB ──────────────────────────
    #[test]
    fn migration_applies_and_creates_the_two_new_tables() {
        let conn = base_db();
        let report = run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        assert_eq!(report.applied, vec![1]);
        assert!(report.already_current.is_empty());
        assert!(table_exists(&conn, "canonical_records"));
        assert!(table_exists(&conn, "operations"));
    }

    // ── 2. Idempotent: second run is a verified no-op ────────────────────────
    #[test]
    fn migration_is_idempotent() {
        let conn = base_db();
        run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        let second = run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        assert!(second.applied.is_empty(), "second run must apply nothing");
        assert_eq!(second.already_current, vec![1]);
        // and a third, to be sure the ALTERs are not retried
        let third = run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        assert!(third.applied.is_empty());
    }

    // ── 3. The five pre-existing tables survive untouched ────────────────────
    #[test]
    fn existing_five_tables_remain() {
        let conn = base_db();
        let before: Vec<Vec<String>> = ["tenants", "branches", "users", "user_branches"]
            .iter()
            .map(|t| columns(&conn, t))
            .collect();
        run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        for t in ["tenants", "branches", "users", "user_branches", "sync_changelog"] {
            assert!(table_exists(&conn, t), "{t} must still exist");
        }
        let after: Vec<Vec<String>> = ["tenants", "branches", "users", "user_branches"]
            .iter()
            .map(|t| columns(&conn, t))
            .collect();
        assert_eq!(before, after, "untouched tables must keep their exact columns");
    }

    // ── 4. Existing changelog rows unchanged; new columns NULL ───────────────
    #[test]
    fn legacy_changelog_rows_are_unchanged_and_new_columns_are_null() {
        let conn = base_db();
        legacy_row(&conn);
        run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();

        let (table, record, action, data, user, created): (String, String, String, String, String, String) = conn
            .query_row(
                "SELECT table_name, record_id, action, data, user_id, created_at FROM sync_changelog WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .unwrap();
        assert_eq!(table, "products");
        assert_eq!(record, "p1");
        assert_eq!(action, "update");
        assert_eq!(data, "{\"brand\":\"X\"}");
        assert_eq!(user, "self-desktop");
        assert_eq!(created, "2026-01-01");

        let (rev, op, pv): (Option<i64>, Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT record_revision, operation_id, protocol_version FROM sync_changelog WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert!(rev.is_none(), "no invented revision backfill");
        assert!(op.is_none());
        assert!(pv.is_none());
    }

    // ── 5. The three additive columns exist, appended at the end ─────────────
    #[test]
    fn changelog_gains_exactly_three_nullable_columns() {
        let conn = base_db();
        let before = columns(&conn, "sync_changelog");
        run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        let after = columns(&conn, "sync_changelog");
        assert_eq!(after.len(), before.len() + 3);
        assert_eq!(&after[..before.len()], &before[..], "existing columns keep position");
        assert_eq!(&after[before.len()..], &["record_revision", "operation_id", "protocol_version"]);
    }

    // ── 6. Nothing is auto-populated ─────────────────────────────────────────
    #[test]
    fn no_rows_are_created_in_the_new_tables() {
        let conn = base_db();
        legacy_row(&conn);
        run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        for t in ["canonical_records", "operations"] {
            let n: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "{t} must stay empty in M6-B1");
        }
    }

    // ── 7. The drift reference must describe exactly the new tables ──────────
    #[test]
    fn reference_sql_is_the_new_table_prefix_of_up_sql() {
        assert!(
            UP_SQL.starts_with(REFERENCE_SQL.trim_end()),
            "REFERENCE_SQL must be the verbatim leading part of UP_SQL — otherwise \
             drift detection would verify a structure that was never applied"
        );
        assert!(!REFERENCE_SQL.contains("ALTER TABLE"));
        assert_eq!(UP_SQL.matches("ALTER TABLE sync_changelog ADD COLUMN").count(), 3);
    }

    // ── 8. Drift detection actually guards the new tables ────────────────────
    #[test]
    fn tampering_with_a_new_table_is_detected_as_drift() {
        let conn = base_db();
        run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        conn.execute_batch("ALTER TABLE canonical_records ADD COLUMN sneaky TEXT;")
            .unwrap();
        let err = run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap_err();
        assert!(
            format!("{err:?}").contains("SchemaDrift"),
            "post-hoc tampering must surface as drift, got: {err:?}"
        );
    }

    // ── 9. authority_epoch is deliberately absent (no false guarantee) ───────
    #[test]
    fn operations_has_no_authority_epoch_yet() {
        let conn = base_db();
        run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        let cols = columns(&conn, "operations");
        assert!(
            !cols.iter().any(|c| c == "authority_epoch"),
            "M6-A4: the authority contract is not enforceable yet — the schema must \
             not imply it. M6-B2 adds the column with the mechanism."
        );
        for expected in [
            "tenant_id", "operation_id", "client_id", "actor_id", "table_name",
            "record_id", "base_revision", "payload_hash", "protocol_version",
            "status", "result_json", "created_at",
        ] {
            assert!(cols.iter().any(|c| c == expected), "operations must carry {expected}");
        }
    }
}
