// ════════════════════════════════════════════════════════════════════════════
// BACKUP-LOCATION — owner-configurable backup root (SSOT + fail-closed resolver).
//
// The owner may point full backups (snapshot + restore) at any writable directory (e.g. an external
// drive). The chosen absolute path is persisted in the CONFIG DB (`backup_location_config`, v0016) — a
// control-plane table, never synced. This module is the SINGLE place that turns "app data dir" into "the
// backups root":
//
//   • `resolve_root(app_data_dir)` returns the configured path if one is stored, else the built-in default
//     `<app_data_dir>/backups`. It reads the config DB READ-ONLY (no migrations, no writes) so it is safe
//     to call from the boot path BEFORE any server/DB is opened, as well as from the runtime commands.
//   • Fail-closed contract: a *configured* path is returned verbatim even when its drive is currently
//     absent — the backup/list then fails VISIBLY against that path, and NEVER silently falls back to the
//     default (a different, "unknown to the user" location). The default is used ONLY when nothing is
//     configured (or the config DB genuinely cannot be read at all — a corrupt config is its own failure).
//   • The renderer never supplies a free path to snapshot/restore: it picks a directory via the native
//     folder dialog, `set_root` validates + write-tests it, and everything downstream re-resolves through
//     here. There is no filesystem-path text input.
// ════════════════════════════════════════════════════════════════════════════

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use super::MediaError;

/// The tenant every desktop install runs under (single-tenant desktop).
pub const TENANT: &str = "tenant-1";
/// Default backups subdirectory under the app data dir.
pub const DEFAULT_SUBDIR: &str = "backups";
const CONFIG_DB: &str = "lataif_sync_server.db";
const WRITE_PROBE: &str = ".lataif_backup_write_test";

/// The built-in default backups root: `<app_data_dir>/backups`.
pub fn default_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DEFAULT_SUBDIR)
}

/// Owner-facing view of the current backup location (for the Settings display). Never an internal error.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupLocationInfo {
    /// The effective backups root (configured path, or the default).
    pub path: String,
    /// True when no custom path is configured (using the default).
    pub is_default: bool,
    /// The built-in default path, always shown so the UI can offer "reset to default".
    pub default_path: String,
}

/// Read the configured backup root from the config DB, READ-ONLY. Returns None when nothing is configured,
/// the table/row is absent, or the DB cannot be opened/read (any error ⇒ None ⇒ caller uses the default).
fn read_configured(app_data_dir: &Path) -> Option<String> {
    let db = app_data_dir.join(CONFIG_DB);
    if !db.exists() {
        return None;
    }
    let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let path: String = conn
        .query_row(
            "SELECT backup_root_path FROM backup_location_config WHERE tenant_id = ?1",
            [TENANT],
            |r| r.get(0),
        )
        .ok()?;
    let trimmed = path.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Resolve the effective backups root. A configured path wins (even if its drive is currently absent —
/// downstream fails visibly against it, never silently at the default). Otherwise the default.
pub fn resolve_root(app_data_dir: &Path) -> PathBuf {
    match read_configured(app_data_dir) {
        Some(p) => PathBuf::from(p),
        None => default_root(app_data_dir),
    }
}

/// The current backup location for the Settings display.
pub fn current(app_data_dir: &Path) -> BackupLocationInfo {
    let default_path = default_root(app_data_dir).to_string_lossy().to_string();
    match read_configured(app_data_dir) {
        Some(p) => BackupLocationInfo { path: p, is_default: false, default_path },
        None => BackupLocationInfo { path: default_path.clone(), is_default: true, default_path },
    }
}

/// Validate a candidate backup root chosen via the native folder dialog, then PROVE it is usable by
/// creating it (if missing) and performing a real write-test. Fail-closed with distinct codes and NO
/// persistence on any failure:
///   • not an absolute path → NotAbsolute,
///   • cannot be created / probe write fails (disconnected/read-only drive) → NotWritable (never a fallback),
///   • OVERLAPS the live app-data tree → OverlapsAppData. A target that is the app-data dir itself, sits
///     INSIDE it (the DBs, `media/`, `mobile-upload-staging/`, the default `backups/`), or is a PARENT of
///     it is refused: the first would snapshot the live databases in place, the second would nest backups
///     recursively (each snapshot swallowing the previous ones), both corrupting the very backup.
/// Returns the normalized absolute path to store on success.
pub fn validate_and_prepare(app_data_dir: &Path, path: &str) -> Result<String, MediaError> {
    let trimmed = path.trim();
    let p = Path::new(trimmed);
    if trimmed.is_empty() || !p.is_absolute() {
        return Err(MediaError::BackupLocationNotAbsolute);
    }
    // Create the directory (and parents) if it does not exist yet. A disconnected/read-only drive fails
    // here → NotWritable (never a fallback).
    std::fs::create_dir_all(p).map_err(|_| MediaError::BackupLocationNotWritable)?;
    // Overlap guard — canonicalize both sides so `.`/`..`/symlinks/case cannot smuggle the target into the
    // live tree. Reject if the target equals, contains, or is contained by the app-data dir. `media/`,
    // `mobile-upload-staging/`, `backups/` and the DB files all live UNDER the app-data dir, so the single
    // ancestor/descendant test against it covers every one of them (and the recursive-nesting case).
    let target_c = std::fs::canonicalize(p).map_err(|_| MediaError::BackupLocationNotWritable)?;
    let app_c = std::fs::canonicalize(app_data_dir)
        .map_err(|e| MediaError::Io(format!("canon app dir: {e}")))?;
    if target_c == app_c || target_c.starts_with(&app_c) || app_c.starts_with(&target_c) {
        return Err(MediaError::BackupLocationOverlapsAppData);
    }
    // Real write-test: create → write → fsync → remove a probe file. Proves we can actually write there
    // now (permissions + medium present), not merely that the directory exists.
    write_probe(p).map_err(|_| MediaError::BackupLocationNotWritable)?;
    Ok(trimmed.to_string())
}

fn write_probe(dir: &Path) -> std::io::Result<()> {
    use std::io::Write;
    let probe = dir.join(WRITE_PROBE);
    {
        let mut f = std::fs::File::create(&probe)?;
        f.write_all(b"lataif-backup-location-write-test")?;
        f.sync_all()?;
    }
    std::fs::remove_file(&probe)?;
    Ok(())
}

/// Persist the owner-chosen backup root (INSERT OR REPLACE — one row per tenant). Caller MUST have
/// verified the owner first. `path` MUST already have passed `validate_and_prepare`.
pub fn set_configured(
    conn: &Connection,
    path: &str,
    updated_by: &str,
    now: &str,
) -> Result<(), MediaError> {
    conn.execute(
        "INSERT INTO backup_location_config (tenant_id, backup_root_path, updated_at, updated_by)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(tenant_id) DO UPDATE SET
             backup_root_path = excluded.backup_root_path,
             updated_at       = excluded.updated_at,
             updated_by       = excluded.updated_by",
        rusqlite::params![TENANT, path, now, updated_by],
    )
    .map_err(|e| MediaError::Io(format!("set backup location: {e}")))?;
    Ok(())
}

/// Reset to the built-in default by removing the configured row. Caller MUST have verified the owner.
pub fn clear_configured(conn: &Connection) -> Result<(), MediaError> {
    conn.execute(
        "DELETE FROM backup_location_config WHERE tenant_id = ?1",
        [TENANT],
    )
    .map_err(|e| MediaError::Io(format!("clear backup location: {e}")))?;
    Ok(())
}

#[cfg(test)]
#[path = "backup_location_tests.rs"]
mod backup_location_tests;
