//! Versioned, additive SQLite migration runner for the authoritative-operation
//! infrastructure (protocol v4).
//!
//! ## A1a scope (inactive infrastructure only)
//!
//! This module creates the migration-metadata table (`schema_migrations`) and
//! drives the additive, INITIALLY EMPTY authoritative-operation tables defined
//! in [`v0001_authoritative_operations`]. It:
//!
//! - never alters an existing table (`tenants`, `branches`, `users`,
//!   `user_branches`, `sync_changelog`),
//! - never inserts a business row (every new table stays empty),
//! - is not wired to any HTTP route, handler, registry or commit wrapper,
//! - leaves the existing last-writer-wins sync untouched.
//!
//! ## Metadata-table mechanism
//!
//! `schema_migrations(version PK, name, checksum, applied_at)` records the
//! applied history. On every start the runner:
//!
//! 1. validates the in-binary migration list is strictly ascending and unique,
//! 2. creates `schema_migrations` if missing and **verifies its exact
//!    structure** (a divergent metadata table aborts with `SCHEMA_DRIFT` — it is
//!    never silently accepted, rebuilt or dropped),
//! 3. verifies the recorded history is an exact, gap-free **prefix** of the
//!    known migrations, with matching `name` and `checksum` per version,
//! 4. applies each pending migration inside one `BEGIN IMMEDIATE … COMMIT`
//!    (structure change, structural verification and marker share the same
//!    transaction); any failure rolls back fully — no partial table, index or
//!    marker survives.
//!
//! Drift detection compares live structure to a reference built from the
//! canonical schema via PRAGMA introspection (columns, primary key, uniqueness,
//! foreign keys, indexes) plus normalized DDL (to catch CHECK drift) — never SQL
//! text alone.

use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

pub mod v0001_authoritative_operations;

#[cfg(test)]
mod tests;

/// All migrations in strictly ascending version order.
pub const ALL_MIGRATIONS: &[Migration] = &[v0001_authoritative_operations::V0001];

/// Fixed DDL for the migration-metadata table. Its structure is re-verified on
/// every start (see [`verify_meta_table`]).
const SCHEMA_MIGRATIONS_DDL: &str = "\
CREATE TABLE IF NOT EXISTS schema_migrations (\n\
    version    INTEGER PRIMARY KEY,\n\
    name       TEXT NOT NULL,\n\
    checksum   TEXT NOT NULL,\n\
    applied_at TEXT NOT NULL\n\
);";

/// A single, immutable migration definition.
#[derive(Debug, Clone)]
pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    /// SQL applied to the target inside `BEGIN IMMEDIATE`.
    pub up_sql: &'static str,
    /// Canonical schema used to build the structural reference for drift
    /// detection. For every production migration this equals `up_sql`
    /// (asserted by a test); it is a separate field only so failure-injection
    /// tests can drive an apply that fails on the target.
    pub reference_sql: &'static str,
}

impl Migration {
    /// Frozen checksum of the migration body (SHA-256 over the LF-normalized
    /// canonical content, lowercase hex).
    pub fn checksum(&self) -> String {
        checksum_of(self.up_sql)
    }
}

/// SHA-256 (via the `sha2` crate) over the LF-normalized migration body —
/// stable across CRLF/LF checkouts.
fn checksum_of(sql: &str) -> String {
    let normalized: String = sql.chars().filter(|&c| c != '\r').collect();
    sha256_hex(normalized.as_bytes())
}

/// Lowercase-hex SHA-256 of `data` using the `sha2` crate.
fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

/// A hard migration failure with a stable, client-safe [`MigrationError::code`].
///
/// **Leak boundary:** only [`MigrationError::code`] (and the structured `version`
/// / `object` fields) are safe to surface to a future client. `Display`, the
/// `source()` chain and the `details` strings may embed raw SQLite messages and
/// must stay server-internal. A1a exposes no endpoint; this is forward guidance
/// for A1d.
#[derive(Debug)]
pub enum MigrationError {
    /// An underlying database error (original cause preserved as `source`).
    Database(rusqlite::Error),
    /// A recorded migration's stored checksum differs from the known one.
    ChecksumMismatch { version: i64 },
    /// A recorded migration's stored name differs from the known one.
    NameMismatch { version: i64 },
    /// The recorded history is not an exact, gap-free prefix of the known
    /// migrations, or the in-binary list is inconsistent.
    HistoryDiverged { details: String },
    /// A live schema object diverges from its canonical definition.
    SchemaDrift { object: String, details: String },
    /// Applying a migration's DDL (or writing its marker) failed.
    ApplyFailed { version: i64, details: String },
}

impl MigrationError {
    /// Stable, client-safe error code.
    pub fn code(&self) -> &'static str {
        match self {
            MigrationError::Database(_) => "MIGRATION_DATABASE_ERROR",
            MigrationError::ChecksumMismatch { .. } => "MIGRATION_CHECKSUM_MISMATCH",
            MigrationError::NameMismatch { .. } => "MIGRATION_NAME_MISMATCH",
            MigrationError::HistoryDiverged { .. } => "MIGRATION_HISTORY_DIVERGED",
            MigrationError::SchemaDrift { .. } => "SCHEMA_DRIFT",
            MigrationError::ApplyFailed { .. } => "MIGRATION_APPLY_FAILED",
        }
    }
}

impl std::fmt::Display for MigrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MigrationError::Database(e) => write!(f, "{}: {}", self.code(), e),
            MigrationError::ChecksumMismatch { version }
            | MigrationError::NameMismatch { version } => {
                write!(f, "{}: version {}", self.code(), version)
            }
            MigrationError::HistoryDiverged { details } => {
                write!(f, "{}: {}", self.code(), details)
            }
            MigrationError::SchemaDrift { object, details } => {
                write!(f, "{}: {} ({})", self.code(), object, details)
            }
            MigrationError::ApplyFailed { version, details } => {
                write!(f, "{}: version {} ({})", self.code(), version, details)
            }
        }
    }
}

impl std::error::Error for MigrationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            MigrationError::Database(e) => Some(e),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for MigrationError {
    fn from(e: rusqlite::Error) -> Self {
        MigrationError::Database(e)
    }
}

/// Summary of a migration run.
#[derive(Debug, Default)]
pub struct MigrationReport {
    /// Versions newly applied during this run.
    pub applied: Vec<i64>,
    /// Versions already present and re-verified drift-free during this run.
    pub already_current: Vec<i64>,
}

/// Apply every pending migration in order. Idempotent: an already-applied,
/// drift-free migration is a verified no-op. Hard-fails on an inconsistent list,
/// metadata/schema drift, a diverged history, or a name/checksum mismatch.
pub fn run_migrations(
    conn: &Connection,
    migrations: &[Migration],
) -> Result<MigrationReport, MigrationError> {
    validate_runner_list(migrations)?;
    ensure_meta_table(conn)?;
    verify_meta_table(conn)?;
    let applied_count = verify_history_prefix(conn, migrations)?;

    let mut report = MigrationReport::default();
    for (i, m) in migrations.iter().enumerate() {
        if i < applied_count {
            // Already recorded (name + checksum already verified) — re-check the
            // live schema so post-hoc tampering surfaces as drift.
            verify_no_drift(conn, m)?;
            report.already_current.push(m.version);
        } else {
            apply_migration(conn, m)?;
            report.applied.push(m.version);
        }
    }
    Ok(report)
}

/// The in-binary migration list must be strictly ascending with unique versions.
fn validate_runner_list(migrations: &[Migration]) -> Result<(), MigrationError> {
    let mut prev: Option<i64> = None;
    for m in migrations {
        if let Some(p) = prev {
            if m.version <= p {
                return Err(MigrationError::HistoryDiverged {
                    details: format!(
                        "in-binary migrations are not strictly ascending: version {} follows {}",
                        m.version, p
                    ),
                });
            }
        }
        prev = Some(m.version);
    }
    Ok(())
}

fn ensure_meta_table(conn: &Connection) -> Result<(), MigrationError> {
    conn.execute_batch(SCHEMA_MIGRATIONS_DDL)?;
    Ok(())
}

/// Verify `schema_migrations` has exactly the expected structure — never accept
/// a divergent metadata table silently.
fn verify_meta_table(conn: &Connection) -> Result<(), MigrationError> {
    let reference = snapshot_from_sql(SCHEMA_MIGRATIONS_DDL)?;
    let expected = reference
        .tables
        .iter()
        .find(|t| t.name == "schema_migrations")
        .expect("reference must contain schema_migrations");
    let actual = snapshot_table(conn, "schema_migrations")?;
    if let Err(details) = compare_table(expected, &actual) {
        return Err(MigrationError::SchemaDrift {
            object: "schema_migrations".to_string(),
            details,
        });
    }
    Ok(())
}

struct AppliedRow {
    version: i64,
    name: String,
    checksum: String,
}

fn read_all_applied(conn: &Connection) -> Result<Vec<AppliedRow>, MigrationError> {
    let mut stmt =
        conn.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC")?;
    let rows = stmt.query_map([], |row| {
        Ok(AppliedRow {
            version: row.get(0)?,
            name: row.get(1)?,
            checksum: row.get(2)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Verify the recorded history is an exact, gap-free prefix of the known
/// migrations (matching version order, name and checksum). Returns the prefix
/// length (number of already-applied migrations).
fn verify_history_prefix(
    conn: &Connection,
    migrations: &[Migration],
) -> Result<usize, MigrationError> {
    let db_rows = read_all_applied(conn)?;
    if db_rows.len() > migrations.len() {
        return Err(MigrationError::HistoryDiverged {
            details: format!(
                "database records {} migrations but only {} are known",
                db_rows.len(),
                migrations.len()
            ),
        });
    }
    for (i, row) in db_rows.iter().enumerate() {
        let known = &migrations[i];
        if row.version != known.version {
            return Err(MigrationError::HistoryDiverged {
                details: format!(
                    "history position {}: database version {} != known version {}",
                    i, row.version, known.version
                ),
            });
        }
        if row.name != known.name {
            return Err(MigrationError::NameMismatch {
                version: known.version,
            });
        }
        if row.checksum != known.checksum() {
            return Err(MigrationError::ChecksumMismatch {
                version: known.version,
            });
        }
    }
    Ok(db_rows.len())
}

/// Apply one pending migration inside a single immediate transaction.
fn apply_migration(conn: &Connection, m: &Migration) -> Result<(), MigrationError> {
    // Built outside the tx; only touches a throwaway in-memory database.
    let reference = build_reference(m)?;

    conn.execute_batch("BEGIN IMMEDIATE;")?;
    let outcome = apply_in_tx(conn, m, &reference);
    match outcome {
        Ok(()) => {
            conn.execute_batch("COMMIT;")?;
            Ok(())
        }
        Err(e) => {
            // Best-effort rollback; the original error is authoritative.
            let _ = conn.execute_batch("ROLLBACK;");
            Err(e)
        }
    }
}

fn apply_in_tx(
    conn: &Connection,
    m: &Migration,
    reference: &SchemaSnapshot,
) -> Result<(), MigrationError> {
    // Structural pre-check: an already-present expected object must match the
    // reference exactly — never silently accept a divergent table.
    for t in &reference.tables {
        if table_exists(conn, &t.name)? {
            let actual = snapshot_table(conn, &t.name)?;
            if let Err(details) = compare_table(t, &actual) {
                return Err(MigrationError::SchemaDrift {
                    object: t.name.clone(),
                    details,
                });
            }
        }
    }

    // Apply the additive DDL (idempotent at the object level).
    conn.execute_batch(m.up_sql)
        .map_err(|e| MigrationError::ApplyFailed {
            version: m.version,
            details: e.to_string(),
        })?;

    // Verify the produced schema matches the reference exactly.
    verify_tables(conn, reference)?;

    // Marker — written in the same transaction; a rollback discards it too.
    conn.execute(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) \
         VALUES (?1, ?2, ?3, ?4)",
        params![m.version, m.name, m.checksum(), now_iso()],
    )
    .map_err(|e| MigrationError::ApplyFailed {
        version: m.version,
        details: e.to_string(),
    })?;

    Ok(())
}

fn verify_no_drift(conn: &Connection, m: &Migration) -> Result<(), MigrationError> {
    let reference = build_reference(m)?;
    verify_tables(conn, &reference)
}

fn verify_tables(conn: &Connection, reference: &SchemaSnapshot) -> Result<(), MigrationError> {
    for t in &reference.tables {
        if !table_exists(conn, &t.name)? {
            return Err(MigrationError::SchemaDrift {
                object: t.name.clone(),
                details: format!("expected table `{}` is missing", t.name),
            });
        }
        let actual = snapshot_table(conn, &t.name)?;
        if let Err(details) = compare_table(t, &actual) {
            return Err(MigrationError::SchemaDrift {
                object: t.name.clone(),
                details,
            });
        }
    }
    Ok(())
}

/// Build the structural reference from a migration's canonical schema.
fn build_reference(m: &Migration) -> Result<SchemaSnapshot, MigrationError> {
    snapshot_from_sql(m.reference_sql)
}

/// Execute `sql` in a throwaway in-memory database and snapshot all its tables.
fn snapshot_from_sql(sql: &str) -> Result<SchemaSnapshot, MigrationError> {
    let ref_conn = Connection::open_in_memory()?;
    ref_conn.execute_batch(sql)?;
    snapshot_all_tables(&ref_conn)
}

// ── Structural introspection ────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
struct ColumnInfo {
    name: String,
    col_type: String,
    notnull: i64,
    dflt: Option<String>,
    pk: i64,
}

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct ForeignKey {
    table: String,
    on_update: String,
    on_delete: String,
    match_clause: String,
    cols: Vec<(String, String)>,
}

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct IndexInfo {
    name: String,
    unique: i64,
    origin: String,
    columns: Vec<String>,
}

struct TableSnapshot {
    name: String,
    columns: Vec<ColumnInfo>,
    fks: Vec<ForeignKey>,
    indexes: Vec<IndexInfo>,
    sql_norm: String,
}

struct SchemaSnapshot {
    tables: Vec<TableSnapshot>,
}

/// Double-quote an identifier for safe interpolation into a `PRAGMA`.
fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

fn snapshot_all_tables(conn: &Connection) -> Result<SchemaSnapshot, MigrationError> {
    let mut names: Vec<String> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT name FROM sqlite_master \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
             ORDER BY name",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        for r in rows {
            names.push(r?);
        }
    }
    let mut tables = Vec::new();
    for n in &names {
        tables.push(snapshot_table(conn, n)?);
    }
    Ok(SchemaSnapshot { tables })
}

fn snapshot_table(conn: &Connection, name: &str) -> Result<TableSnapshot, MigrationError> {
    // Columns (table_info returns them in column order).
    let mut columns = Vec::new();
    {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", quote_ident(name)))?;
        let rows = stmt.query_map([], |row| {
            Ok(ColumnInfo {
                name: row.get("name")?,
                col_type: row.get("type")?,
                notnull: row.get("notnull")?,
                dflt: row.get("dflt_value")?,
                pk: row.get("pk")?,
            })
        })?;
        for r in rows {
            columns.push(r?);
        }
    }

    // Foreign keys (grouped by id, ordered by seq).
    let mut fk_rows: Vec<(
        i64,
        i64,
        String,
        String,
        Option<String>,
        String,
        String,
        String,
    )> = Vec::new();
    {
        let mut stmt = conn.prepare(&format!("PRAGMA foreign_key_list({})", quote_ident(name)))?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>("id")?,
                row.get::<_, i64>("seq")?,
                row.get::<_, String>("table")?,
                row.get::<_, String>("from")?,
                row.get::<_, Option<String>>("to")?,
                row.get::<_, String>("on_update")?,
                row.get::<_, String>("on_delete")?,
                row.get::<_, String>("match")?,
            ))
        })?;
        for r in rows {
            fk_rows.push(r?);
        }
    }
    let fks = group_fks(fk_rows);

    // Indexes (auto-indexes for PK/UNIQUE included), each with its columns.
    let mut idx_meta: Vec<(String, i64, String)> = Vec::new();
    {
        let mut stmt = conn.prepare(&format!("PRAGMA index_list({})", quote_ident(name)))?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>("name")?,
                row.get::<_, i64>("unique")?,
                row.get::<_, String>("origin")?,
            ))
        })?;
        for r in rows {
            idx_meta.push(r?);
        }
    }
    let mut indexes = Vec::new();
    for (iname, unique, origin) in idx_meta {
        let mut cols = Vec::new();
        let mut stmt = conn.prepare(&format!("PRAGMA index_info({})", quote_ident(&iname)))?;
        let rows = stmt.query_map([], |row| row.get::<_, Option<String>>("name"))?;
        for r in rows {
            cols.push(r?.unwrap_or_else(|| "<expr>".to_string()));
        }
        indexes.push(IndexInfo {
            name: iname,
            unique,
            origin,
            columns: cols,
        });
    }
    indexes.sort();

    // Stored DDL (normalized) — catches CHECK constraints PRAGMA cannot see.
    let sql: Option<String> = conn.query_row(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![name],
        |row| row.get::<_, Option<String>>(0),
    )?;
    let sql_norm = normalize_ws(&sql.unwrap_or_default());

    Ok(TableSnapshot {
        name: name.to_string(),
        columns,
        fks,
        indexes,
        sql_norm,
    })
}

#[allow(clippy::type_complexity)]
fn group_fks(
    rows: Vec<(
        i64,
        i64,
        String,
        String,
        Option<String>,
        String,
        String,
        String,
    )>,
) -> Vec<ForeignKey> {
    use std::collections::BTreeMap;
    let mut groups: BTreeMap<
        i64,
        Vec<(i64, String, String, Option<String>, String, String, String)>,
    > = BTreeMap::new();
    for (id, seq, table, from, to, on_update, on_delete, match_clause) in rows {
        groups.entry(id).or_default().push((
            seq,
            table,
            from,
            to,
            on_update,
            on_delete,
            match_clause,
        ));
    }
    let mut fks = Vec::new();
    for (_id, mut group) in groups {
        group.sort_by_key(|x| x.0);
        let table = group[0].1.clone();
        let on_update = group[0].4.clone();
        let on_delete = group[0].5.clone();
        let match_clause = group[0].6.clone();
        let cols = group
            .iter()
            .map(|x| (x.2.clone(), x.3.clone().unwrap_or_default()))
            .collect();
        fks.push(ForeignKey {
            table,
            on_update,
            on_delete,
            match_clause,
            cols,
        });
    }
    fks.sort();
    fks
}

fn compare_table(expected: &TableSnapshot, actual: &TableSnapshot) -> Result<(), String> {
    if expected.columns != actual.columns {
        return Err(format!(
            "table `{}`: column definitions differ (expected {:?}, found {:?})",
            expected.name, expected.columns, actual.columns
        ));
    }
    if expected.fks != actual.fks {
        return Err(format!(
            "table `{}`: foreign keys differ (expected {:?}, found {:?})",
            expected.name, expected.fks, actual.fks
        ));
    }
    if expected.indexes != actual.indexes {
        return Err(format!(
            "table `{}`: indexes differ (expected {:?}, found {:?})",
            expected.name, expected.indexes, actual.indexes
        ));
    }
    if expected.sql_norm != actual.sql_norm {
        return Err(format!(
            "table `{}`: normalized DDL differs (CHECK/other constraint drift)",
            expected.name
        ));
    }
    Ok(())
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool, MigrationError> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![name],
        |row| row.get(0),
    )?;
    Ok(n > 0)
}

fn normalize_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}
