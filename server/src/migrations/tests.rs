//! Migration, schema, drift, rollback and backward-compatibility tests.
//!
//! All tests run against isolated in-memory databases. The real
//! `server/lataif_server.db` is never opened. There is no production back-door:
//! every helper here lives under `#[cfg(test)]`.

use super::v0001_authoritative_operations::V0001;
use super::*;
use rusqlite::{params, Connection, OptionalExtension};

/// Frozen checksum of migration v0001 (LF-normalized SHA-256 of its body).
const EXPECTED_V0001_CHECKSUM: &str =
    "537ee35ab94b9d2ae87f9da4cb74a8a7bea410284265059a88b9928fcba7887c";

/// Base server schema — a faithful copy of `db::init_database`'s tables, used to
/// reproduce "today's database" for backward-compatibility tests.
const BASE_SCHEMA: &str = "
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
";

const BASE_TABLES: &[&str] = &[
    "tenants",
    "branches",
    "users",
    "user_branches",
    "sync_changelog",
];

const NEW_TABLES: &[&str] = &[
    "server_state",
    "operations",
    "operation_sequence",
    "aggregate_revisions",
    "canonical_records",
    "operation_envelopes",
    "operation_mutations",
    "auth_ledger_entries",
    "ledger_sequence",
];

const EXPECTED_INDEXES: &[&str] = &[
    "idx_operations_branch_committed",
    "idx_operations_type_committed",
    "idx_operations_actor_committed",
    "idx_operation_sequence_branch_seq",
    "idx_canonical_records_table_updated",
    "idx_canonical_records_last_op",
    "idx_operation_envelopes_branch_seq",
    "idx_operation_mutations_table_record",
    "idx_operation_mutations_op_ordinal",
    "idx_auth_ledger_entries_txn",
    "idx_auth_ledger_entries_account",
    "idx_auth_ledger_entries_counterparty",
    "idx_auth_ledger_entries_op",
];

fn base_conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    conn.execute_batch(BASE_SCHEMA).unwrap();
    conn
}

fn seed(conn: &Connection) {
    conn.execute_batch(
        "
        INSERT INTO tenants (id,name,slug,plan,active,max_branches,max_users,created_at,updated_at)
            VALUES ('t1','Tenant One','tenant-one','starter',1,3,10,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
        INSERT INTO branches (id,tenant_id,name,country,currency,address,active,created_at,updated_at)
            VALUES ('b1','t1','Main','BH','BHD','Manama',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
        INSERT INTO users (id,tenant_id,email,password_hash,name,active,created_at,updated_at)
            VALUES ('u1','t1','ali@lataif.com','hash','Ali',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
        INSERT INTO user_branches (user_id,branch_id,role,is_default,created_at)
            VALUES ('u1','b1','owner',1,'2026-01-01T00:00:00Z');
        INSERT INTO sync_changelog (tenant_id,branch_id,table_name,record_id,action,data,user_id,created_at)
            VALUES ('t1','b1','invoices','inv1','insert','{\"x\":1}','u1','2026-01-02T00:00:00Z');
        INSERT INTO sync_changelog (tenant_id,branch_id,table_name,record_id,action,data,user_id,created_at)
            VALUES ('t1','b1','invoices','inv1','update','{\"x\":2}','u1','2026-01-02T01:00:00Z');
        ",
    )
    .unwrap();
}

fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT count(*) FROM \"{}\"", table), [], |r| {
        r.get(0)
    })
    .unwrap()
}

fn object_exists(conn: &Connection, name: &str) -> bool {
    let n: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = ?1",
            params![name],
            |r| r.get(0),
        )
        .unwrap();
    n > 0
}

/// Total count of user objects (tables + indexes) excluding SQLite internals.
fn object_count(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

/// Normalized schema + sorted data fingerprint of the given tables.
fn fingerprint(conn: &Connection, tables: &[&str]) -> String {
    let mut out = String::new();
    for t in tables {
        let sql: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name = ?1",
                params![t],
                |r| r.get(0),
            )
            .unwrap();
        out.push_str(&format!(
            "== {} schema ==\n{}\n",
            t,
            sql.unwrap_or_default()
        ));
        let mut stmt = conn.prepare(&format!("SELECT * FROM \"{}\"", t)).unwrap();
        let ncol = stmt.column_count();
        let rows = stmt
            .query_map([], |row| {
                let mut cells = Vec::new();
                for i in 0..ncol {
                    let v: rusqlite::types::Value = row.get(i)?;
                    cells.push(format!("{:?}", v));
                }
                Ok(cells.join("|"))
            })
            .unwrap();
        let mut data: Vec<String> = rows.map(|r| r.unwrap()).collect();
        data.sort();
        out.push_str("== data ==\n");
        for d in data {
            out.push_str(&d);
            out.push('\n');
        }
    }
    out
}

// 1. Fresh DB: all objects created, every new table empty.
#[test]
fn fresh_db_applies_and_tables_empty() {
    let conn = base_conn();
    let report = run_migrations(&conn, ALL_MIGRATIONS).unwrap();
    assert_eq!(report.applied, vec![1]);
    assert!(report.already_current.is_empty());
    for t in NEW_TABLES {
        assert!(object_exists(&conn, t), "missing table {}", t);
        assert_eq!(count(&conn, t), 0, "table {} not empty", t);
    }
    for ix in EXPECTED_INDEXES {
        assert!(object_exists(&conn, ix), "missing index {}", ix);
    }
    assert_eq!(count(&conn, "schema_migrations"), 1);
}

// 2 + 10. Existing DB with data: schema and rows byte-identical after migration.
#[test]
fn existing_db_schema_and_data_unchanged() {
    let conn = base_conn();
    seed(&conn);
    let before = fingerprint(&conn, BASE_TABLES);
    let report = run_migrations(&conn, ALL_MIGRATIONS).unwrap();
    assert_eq!(report.applied, vec![1]);
    let after = fingerprint(&conn, BASE_TABLES);
    assert_eq!(before, after, "existing base tables changed");
    for t in NEW_TABLES {
        assert_eq!(count(&conn, t), 0, "new table {} not empty", t);
    }
}

// 3. Second run is an idempotent no-op (no new objects, marker stays 1).
#[test]
fn second_run_is_idempotent_noop() {
    let conn = base_conn();
    let r1 = run_migrations(&conn, ALL_MIGRATIONS).unwrap();
    assert_eq!(r1.applied, vec![1]);
    let objects_before = object_count(&conn);

    let r2 = run_migrations(&conn, ALL_MIGRATIONS).unwrap();
    assert!(r2.applied.is_empty());
    assert_eq!(r2.already_current, vec![1]);

    assert_eq!(
        object_count(&conn),
        objects_before,
        "second run created objects"
    );
    assert_eq!(count(&conn, "schema_migrations"), 1);
    let stored: String = conn
        .query_row(
            "SELECT checksum FROM schema_migrations WHERE version = 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stored, V0001.checksum());
}

// 4. Stored version with a different checksum aborts hard.
#[test]
fn checksum_mismatch_aborts() {
    let conn = base_conn();
    run_migrations(&conn, ALL_MIGRATIONS).unwrap();
    conn.execute(
        "UPDATE schema_migrations SET checksum = 'deadbeef' WHERE version = 1",
        [],
    )
    .unwrap();
    let err = run_migrations(&conn, ALL_MIGRATIONS).unwrap_err();
    assert_eq!(err.code(), "MIGRATION_CHECKSUM_MISMATCH");
}

// 5. Pre-existing table with a missing column → SCHEMA_DRIFT.
#[test]
fn drift_missing_column_aborts() {
    let conn = base_conn();
    conn.execute_batch(
        "CREATE TABLE operations (
            tenant_id TEXT NOT NULL,
            operation_id TEXT NOT NULL,
            PRIMARY KEY (tenant_id, operation_id)
        );",
    )
    .unwrap();
    let err = run_migrations(&conn, ALL_MIGRATIONS).unwrap_err();
    assert_eq!(err.code(), "SCHEMA_DRIFT");
    assert!(err.to_string().contains("operations"));
}

// 6. Pre-existing table with a wrong primary key → SCHEMA_DRIFT.
#[test]
fn drift_wrong_primary_key_aborts() {
    let conn = base_conn();
    conn.execute_batch(
        "CREATE TABLE ledger_sequence (
            tenant_id TEXT NOT NULL,
            branch_id TEXT NOT NULL,
            next_entry_no INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (tenant_id),
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
            FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,
            CHECK (next_entry_no >= 1)
        );",
    )
    .unwrap();
    let err = run_migrations(&conn, ALL_MIGRATIONS).unwrap_err();
    assert_eq!(err.code(), "SCHEMA_DRIFT");
    assert!(err.to_string().contains("ledger_sequence"));
}

// 7. A renamed-but-wrong index → SCHEMA_DRIFT (verified on a later run).
#[test]
fn drift_wrong_index_aborts() {
    let conn = base_conn();
    run_migrations(&conn, ALL_MIGRATIONS).unwrap();
    conn.execute_batch(
        "DROP INDEX idx_operations_branch_committed;
         CREATE INDEX idx_operations_branch_committed ON operations(actor_id);",
    )
    .unwrap();
    let err = run_migrations(&conn, ALL_MIGRATIONS).unwrap_err();
    assert_eq!(err.code(), "SCHEMA_DRIFT");
    assert!(err.to_string().contains("operations"));
}

// 8. Pre-existing table with a wrong foreign key → SCHEMA_DRIFT.
#[test]
fn drift_wrong_foreign_key_aborts() {
    let conn = base_conn();
    conn.execute_batch(
        "CREATE TABLE ledger_sequence (
            tenant_id TEXT NOT NULL,
            branch_id TEXT NOT NULL,
            next_entry_no INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (tenant_id, branch_id),
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
            FOREIGN KEY (branch_id) REFERENCES tenants(id) ON DELETE RESTRICT,
            CHECK (next_entry_no >= 1)
        );",
    )
    .unwrap();
    let err = run_migrations(&conn, ALL_MIGRATIONS).unwrap_err();
    assert_eq!(err.code(), "SCHEMA_DRIFT");
    assert!(err.to_string().contains("ledger_sequence"));
}

// 9. A deliberately failing migration rolls back fully: no partial object, no marker.
#[test]
fn failing_migration_rolls_back_completely() {
    let conn = base_conn();
    let failing = Migration {
        version: 1,
        name: "deliberate_failure",
        up_sql: "CREATE TABLE rollback_probe (id TEXT PRIMARY KEY);\n\
                 CREATE TABLE rollback_probe (id TEXT);",
        reference_sql: "CREATE TABLE rollback_probe (id TEXT PRIMARY KEY);",
    };
    let err = run_migrations(&conn, std::slice::from_ref(&failing)).unwrap_err();
    assert_eq!(err.code(), "MIGRATION_APPLY_FAILED");
    assert!(
        !table_exists(&conn, "rollback_probe").unwrap(),
        "partial table survived rollback"
    );
    let marker: Option<i64> = conn
        .query_row(
            "SELECT version FROM schema_migrations WHERE version = 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .unwrap();
    assert_eq!(marker, None, "marker written despite rollback");
}

// 11. Absent server_state row is logically NOT_INITIALIZED.
#[test]
fn server_state_absent_is_logically_not_initialized() {
    let conn = base_conn();
    run_migrations(&conn, ALL_MIGRATIONS).unwrap();
    let state: Option<String> = conn
        .query_row(
            "SELECT finance_state FROM server_state WHERE tenant_id = ?1 AND plane = 'finance'",
            params!["t1"],
            |r| r.get(0),
        )
        .optional()
        .unwrap();
    assert_eq!(state, None);
    let logical = state.unwrap_or_else(|| "NOT_INITIALIZED".to_string());
    assert_eq!(logical, "NOT_INITIALIZED");
}

// 12. All new business tables have row count 0 immediately after migration.
#[test]
fn new_tables_have_zero_rows() {
    let conn = base_conn();
    run_migrations(&conn, ALL_MIGRATIONS).unwrap();
    for t in NEW_TABLES {
        assert_eq!(count(&conn, t), 0, "table {} should be empty", t);
    }
}

// SHA-256 primitive anchored to FIPS 180-4 known-answer vectors.
#[test]
fn sha256_known_answer_vectors() {
    assert_eq!(
        super::sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        super::sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

// Every production migration's reference schema equals its applied SQL.
#[test]
fn production_migrations_reference_equals_up_sql() {
    for m in ALL_MIGRATIONS {
        assert_eq!(m.up_sql, m.reference_sql, "v{}", m.version);
    }
}

// v0001 checksum is frozen — any accidental schema edit fails this gate.
#[test]
fn v0001_checksum_is_frozen() {
    assert_eq!(V0001.checksum(), EXPECTED_V0001_CHECKSUM);
}

/// Insert a minimal `accepted` operations row (FK-valid against the seed rows).
fn insert_accepted_operation(conn: &Connection, op_id: &str) {
    conn.execute(
        "INSERT INTO operations (
            tenant_id, operation_id, branch_id, operation_type, protocol_version,
            actor_id, payload_hash, canonical_payload_json, status, result_json,
            created_at, committed_at
         ) VALUES (
            't1', ?1, 'b1', 'APPLY_SUPPLIER_CREDIT_TO_EXPENSES', 4,
            'u1', ?2, '{}', 'accepted', '{}',
            '2026-01-03T00:00:00Z', '2026-01-03T00:00:01Z'
         )",
        params![op_id, "a".repeat(64)],
    )
    .unwrap();
}

// Schema enforces at-most-once: a replayed operation cannot get a 2nd sequence
// (UNIQUE(tenant_id, operation_id) on operation_sequence). §4.3.
#[test]
fn operation_sequence_rejects_duplicate_for_same_operation() {
    let conn = base_conn();
    seed(&conn);
    run_migrations(&conn, ALL_MIGRATIONS).unwrap();
    insert_accepted_operation(&conn, "op-1");

    conn.execute(
        "INSERT INTO operation_sequence (tenant_id, branch_id, operation_id, created_at)
         VALUES ('t1', 'b1', 'op-1', '2026-01-03T00:00:02Z')",
        [],
    )
    .unwrap();
    let dup = conn.execute(
        "INSERT INTO operation_sequence (tenant_id, branch_id, operation_id, created_at)
         VALUES ('t1', 'b1', 'op-1', '2026-01-03T00:00:03Z')",
        [],
    );
    assert!(
        dup.is_err(),
        "duplicate sequence for same operation must be rejected"
    );
}

// Schema enforces at-most-once: a duplicate operation_id within a tenant is
// rejected by PRIMARY KEY(tenant_id, operation_id) on operations. §4.2.
#[test]
fn operations_primary_key_rejects_duplicate_id() {
    let conn = base_conn();
    seed(&conn);
    run_migrations(&conn, ALL_MIGRATIONS).unwrap();
    insert_accepted_operation(&conn, "op-1");
    let again = conn.execute(
        "INSERT INTO operations (
            tenant_id, operation_id, branch_id, operation_type, protocol_version,
            actor_id, payload_hash, canonical_payload_json, status, result_json,
            created_at, committed_at
         ) VALUES (
            't1', 'op-1', 'b1', 'APPLY_SUPPLIER_CREDIT_TO_EXPENSES', 4,
            'u1', ?1, '{}', 'accepted', '{}',
            '2026-01-03T00:00:00Z', '2026-01-03T00:00:01Z'
         )",
        params!["a".repeat(64)],
    );
    assert!(
        again.is_err(),
        "duplicate operation_id must be rejected by the primary key"
    );
}

/// Create `schema_migrations` with the exact expected structure (for history
/// tests that pre-populate rows).
fn create_correct_meta(conn: &Connection) {
    conn.execute_batch(super::SCHEMA_MIGRATIONS_DDL).unwrap();
}

fn insert_history_row(conn: &Connection, version: i64, name: &str, checksum: &str) {
    conn.execute(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at)
         VALUES (?1, ?2, ?3, '2026-01-01T00:00:00Z')",
        params![version, name, checksum],
    )
    .unwrap();
}

// Meta-table self-verification: a missing column → SCHEMA_DRIFT.
#[test]
fn meta_table_drift_missing_column() {
    let conn = base_conn();
    conn.execute_batch(
        "CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            checksum TEXT NOT NULL
        );",
    )
    .unwrap();
    let err = run_migrations(&conn, ALL_MIGRATIONS).unwrap_err();
    assert_eq!(err.code(), "SCHEMA_DRIFT");
    assert!(err.to_string().contains("schema_migrations"));
}

// Meta-table self-verification: a wrong primary key → SCHEMA_DRIFT.
#[test]
fn meta_table_drift_wrong_primary_key() {
    let conn = base_conn();
    conn.execute_batch(
        "CREATE TABLE schema_migrations (
            version INTEGER,
            name TEXT NOT NULL,
            checksum TEXT NOT NULL,
            applied_at TEXT NOT NULL,
            PRIMARY KEY (name)
        );",
    )
    .unwrap();
    let err = run_migrations(&conn, ALL_MIGRATIONS).unwrap_err();
    assert_eq!(err.code(), "SCHEMA_DRIFT");
    assert!(err.to_string().contains("schema_migrations"));
}

// Meta-table self-verification: wrong nullability/type → SCHEMA_DRIFT.
#[test]
fn meta_table_drift_wrong_nullability_or_type() {
    let conn = base_conn();
    conn.execute_batch(
        "CREATE TABLE schema_migrations (
            version TEXT PRIMARY KEY,
            name TEXT,
            checksum TEXT NOT NULL,
            applied_at TEXT NOT NULL
        );",
    )
    .unwrap();
    let err = run_migrations(&conn, ALL_MIGRATIONS).unwrap_err();
    assert_eq!(err.code(), "SCHEMA_DRIFT");
    assert!(err.to_string().contains("schema_migrations"));
}

// Meta-table self-verification: a structurally divergent (extra-column) table
// → SCHEMA_DRIFT.
#[test]
fn meta_table_drift_extra_column() {
    let conn = base_conn();
    conn.execute_batch(
        "CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            checksum TEXT NOT NULL,
            applied_at TEXT NOT NULL,
            extra TEXT
        );",
    )
    .unwrap();
    let err = run_migrations(&conn, ALL_MIGRATIONS).unwrap_err();
    assert_eq!(err.code(), "SCHEMA_DRIFT");
    assert!(err.to_string().contains("schema_migrations"));
}

// Same version, different name → MIGRATION_NAME_MISMATCH.
#[test]
fn name_mismatch_aborts() {
    let conn = base_conn();
    run_migrations(&conn, ALL_MIGRATIONS).unwrap();
    conn.execute(
        "UPDATE schema_migrations SET name = 'renamed' WHERE version = 1",
        [],
    )
    .unwrap();
    let err = run_migrations(&conn, ALL_MIGRATIONS).unwrap_err();
    assert_eq!(err.code(), "MIGRATION_NAME_MISMATCH");
}

// History: DB records only an unknown version 2 → MIGRATION_HISTORY_DIVERGED.
#[test]
fn history_diverged_db_only_version_2() {
    let conn = base_conn();
    create_correct_meta(&conn);
    insert_history_row(&conn, 2, "authoritative_operations", &V0001.checksum());
    let err = run_migrations(&conn, ALL_MIGRATIONS).unwrap_err();
    assert_eq!(err.code(), "MIGRATION_HISTORY_DIVERGED");
}

// History: DB has v1 plus an unknown higher v2 → MIGRATION_HISTORY_DIVERGED.
#[test]
fn history_diverged_unknown_higher_version() {
    let conn = base_conn();
    create_correct_meta(&conn);
    insert_history_row(&conn, 1, "authoritative_operations", &V0001.checksum());
    insert_history_row(&conn, 2, "future", "00");
    let err = run_migrations(&conn, ALL_MIGRATIONS).unwrap_err();
    assert_eq!(err.code(), "MIGRATION_HISTORY_DIVERGED");
}

// Runner: a duplicate version in the in-binary list → MIGRATION_HISTORY_DIVERGED.
#[test]
fn runner_duplicate_version_rejected() {
    let conn = base_conn();
    let dup: &[Migration] = &[
        Migration {
            version: 1,
            name: "a",
            up_sql: "",
            reference_sql: "",
        },
        Migration {
            version: 1,
            name: "b",
            up_sql: "",
            reference_sql: "",
        },
    ];
    let err = run_migrations(&conn, dup).unwrap_err();
    assert_eq!(err.code(), "MIGRATION_HISTORY_DIVERGED");
}

// Runner: a non-ascending in-binary list → MIGRATION_HISTORY_DIVERGED.
#[test]
fn runner_unsorted_versions_rejected() {
    let conn = base_conn();
    let unsorted: &[Migration] = &[
        Migration {
            version: 2,
            name: "b",
            up_sql: "",
            reference_sql: "",
        },
        Migration {
            version: 1,
            name: "a",
            up_sql: "",
            reference_sql: "",
        },
    ];
    let err = run_migrations(&conn, unsorted).unwrap_err();
    assert_eq!(err.code(), "MIGRATION_HISTORY_DIVERGED");
}
