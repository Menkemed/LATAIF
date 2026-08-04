// ════════════════════════════════════════════════════════════════════════════
// BACKUP-RETENTION — owner-configurable "keep last N complete snapshots".
//
// Retention is OFF until the owner explicitly enables it (v0017 `backup_retention_config`, control-plane).
// Nothing is ever auto-deleted before activation. When enabled, prune runs ONLY at boot AFTER a fully
// successful, published snapshot (see backup.rs `execute_pending_backup`), and only:
//   • considers directories that pass the FULL complete-manifest pre-check (`restore::list_snapshots`),
//   • re-resolves each deletion candidate through `resolve_snapshot_id` (safe segment, under the backups
//     root, not a symlink) and re-validates it complete BEFORE removing — never a blind `rm -rf`,
//   • NEVER deletes the newest snapshot (keep_count >= 1, and the newest is index 0),
//   • SKIPS entirely while a restore intent is pending (a restore must not overlap a prune),
//   • surfaces per-item delete failures (counted + logged) without ever undoing the just-created backup.
// Works for both the default and a custom backup root (everything resolves through backup_location).
// ════════════════════════════════════════════════════════════════════════════

use std::path::Path;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use super::MediaError;

pub const TENANT: &str = "tenant-1";
pub const DEFAULT_KEEP: i64 = 10;
pub const MIN_KEEP: i64 = 1;
pub const MAX_KEEP: i64 = 1000;
const CONFIG_DB: &str = "lataif_sync_server.db";

#[derive(Debug, Clone, Copy)]
pub struct RetentionConfig {
    pub enabled: bool,
    pub keep_count: i64,
}

/// Owner-facing view for the Settings UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionInfo {
    pub enabled: bool,
    pub keep_count: i64,
    pub default_keep: i64,
}

/// Read the retention config READ-ONLY. Absent row / unreadable DB ⇒ DISABLED (never prunes) with the
/// default keep count — fail-safe: retention only ever runs when an owner has explicitly turned it on.
fn read_config(app_data_dir: &Path) -> RetentionConfig {
    let db = app_data_dir.join(CONFIG_DB);
    let disabled = RetentionConfig { enabled: false, keep_count: DEFAULT_KEEP };
    if !db.exists() {
        return disabled;
    }
    let conn = match Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(c) => c,
        Err(_) => return disabled,
    };
    conn.query_row(
        "SELECT enabled, keep_count FROM backup_retention_config WHERE tenant_id = ?1",
        [TENANT],
        |r| {
            let enabled: i64 = r.get(0)?;
            let keep: i64 = r.get(1)?;
            Ok(RetentionConfig { enabled: enabled != 0, keep_count: clamp_keep(keep) })
        },
    )
    .unwrap_or(disabled)
}

pub fn clamp_keep(n: i64) -> i64 {
    n.clamp(MIN_KEEP, MAX_KEEP)
}

/// Current retention for the Settings display.
pub fn current(app_data_dir: &Path) -> RetentionInfo {
    let c = read_config(app_data_dir);
    RetentionInfo { enabled: c.enabled, keep_count: c.keep_count, default_keep: DEFAULT_KEEP }
}

/// Persist the owner-chosen retention (INSERT OR REPLACE). Caller MUST have verified the owner. keep_count
/// is clamped to [MIN_KEEP, MAX_KEEP]. Enabling does NOT prune here — prune runs after the next backup.
pub fn set_configured(
    conn: &Connection,
    enabled: bool,
    keep_count: i64,
    updated_by: &str,
    now: &str,
) -> Result<(), MediaError> {
    conn.execute(
        "INSERT INTO backup_retention_config (tenant_id, enabled, keep_count, updated_at, updated_by)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(tenant_id) DO UPDATE SET
             enabled = excluded.enabled,
             keep_count = excluded.keep_count,
             updated_at = excluded.updated_at,
             updated_by = excluded.updated_by",
        rusqlite::params![TENANT, enabled as i64, clamp_keep(keep_count), now, updated_by],
    )
    .map_err(|e| MediaError::Io(format!("set retention: {e}")))?;
    Ok(())
}

/// Outcome of a prune pass (logged after a backup; also returned for tests).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneReport {
    pub enabled: bool,
    pub kept: usize,
    pub deleted: usize,
    pub failed: usize,
    pub skipped_restore_pending: bool,
}

/// Prune old snapshots to the configured "keep last N". Best-effort + fail-safe:
///   • disabled ⇒ no-op; a pending restore ⇒ skip (no overlap);
///   • lists ONLY valid, complete, pre-checked snapshots (newest first) — incomplete/foreign dirs are never
///     even seen, let alone deleted;
///   • keeps the newest `keep_count` (>=1), re-resolves + re-validates each older one before removing;
///   • a per-item delete failure is counted, not fatal — the just-created backup is never undone.
pub fn prune(app_data_dir: &Path) -> PruneReport {
    let cfg = read_config(app_data_dir);
    if !cfg.enabled {
        return PruneReport { enabled: false, ..Default::default() };
    }
    // A restore must not overlap a prune. At boot the scheduled restore already ran + cleared its intent
    // before backup; this is a defensive guard for any lingering intent.
    if super::restore_recovery::read_intent(app_data_dir).is_some() {
        return PruneReport { enabled: true, skipped_restore_pending: true, ..Default::default() };
    }
    let keep = clamp_keep(cfg.keep_count) as usize;
    // Complete, fully pre-checked snapshots only, newest first.
    let snaps = super::restore::list_snapshots(app_data_dir).unwrap_or_default();
    if snaps.len() <= keep {
        return PruneReport { enabled: true, kept: snaps.len(), ..Default::default() };
    }
    let mut deleted = 0usize;
    let mut failed = 0usize;
    // snaps[0..keep] are retained (incl. the newest at 0); snaps[keep..] are the oldest surplus.
    for s in &snaps[keep..] {
        match delete_one(app_data_dir, &s.snapshot_id) {
            Ok(()) => deleted += 1,
            Err(_) => failed += 1, // surfaced via the caller's log; never fatal
        }
    }
    PruneReport { enabled: true, kept: keep, deleted, failed, skipped_restore_pending: false }
}

/// Delete confinement — every guard must hold or the snapshot is left in place (counted as failed):
///   1. the candidate PATH `<root>/<id>` must NOT be a reparse point. `is_symlink()` misses Windows
///      directory JUNCTIONS (reparse tag MOUNT_POINT, not SYMLINK), so we check FILE_ATTRIBUTE_REPARSE_POINT
///      explicitly and fail-closed on any metadata error — a junction snapshot is never followed/deleted;
///   2. `resolve_snapshot_id` re-confirms a safe single segment, canonicalises, and asserts the target is a
///      DIRECT child of the canonical active backups root (no parent/root/AppData escape);
///   3. it must be a valid COMPLETE snapshot (re-validated here);
///   4. IMMEDIATELY before removal we re-check the reparse guard AND re-derive the canonical root + assert
///      direct-child again (a TOCTOU re-check — we do NOT rely on the boot being single-threaded);
///   5. `remove_dir_all` itself does not follow reparse points during recursion (Rust's CVE-2022-21658
///      fix), so even a nested junction inside a snapshot is unlinked as an entry, never descended into.
fn delete_one(app_data_dir: &Path, snapshot_id: &str) -> Result<(), MediaError> {
    let root = super::backup_location::resolve_root(app_data_dir);
    let raw = root.join(snapshot_id);
    if is_reparse_point(&raw) {
        return Err(MediaError::PathReparsePointForbidden); // (1) junction/symlink candidate — never follow it
    }
    let dir = super::restore::resolve_snapshot_id(app_data_dir, snapshot_id)?; // (2) confined direct child
    super::restore::validate_snapshot(&dir)?; // (3) only a complete snapshot is ever deletable
    // (4) TOCTOU re-check right before the destructive op — reparse guard + direct-child under canonical root.
    if is_reparse_point(&raw) {
        return Err(MediaError::PathReparsePointForbidden);
    }
    let root_c = std::fs::canonicalize(&root).map_err(|e| MediaError::Io(format!("prune root canon: {e}")))?;
    if dir.parent() != Some(root_c.as_path()) {
        return Err(MediaError::PathOutsideRoot);
    }
    std::fs::remove_dir_all(&dir).map_err(|e| MediaError::Io(format!("prune remove: {e}"))) // (5)
}

/// True if `p` is a reparse point (symlink OR Windows directory junction/mount-point). Fail-closed: any
/// metadata error returns true so an unreadable/absent candidate is never blindly deleted.
#[cfg(windows)]
fn is_reparse_point(p: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    match std::fs::symlink_metadata(p) {
        Ok(m) => m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0,
        Err(_) => true,
    }
}
#[cfg(not(windows))]
fn is_reparse_point(p: &Path) -> bool {
    match std::fs::symlink_metadata(p) {
        Ok(m) => m.file_type().is_symlink(),
        Err(_) => true,
    }
}

#[cfg(test)]
#[path = "backup_retention_tests.rs"]
mod backup_retention_tests;
