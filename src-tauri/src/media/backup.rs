//! MEDIA-04B2A12-I2 — REAL host implementation of the consistent DB+media backup snapshot.
//!
//! The JS orchestrator (`core/media/backup-snapshot.ts`) models the contract; THIS is the production
//! host that actually touches the filesystem and databases. It reuses the audited storage safety
//! helpers so the fail-closed guarantees are real, not claimed:
//!   • server DB is WAL-checkpointed (TRUNCATE) so its snapshot folds in the WAL — one consistent file,
//!   • both DB files are copied + SHA-256'd,
//!   • every required media file is read via `storage::read_verified_media` → canonical-root +
//!     no-reparse/symlink + content-hash verification are ENFORCED (missing/corrupt/symlink/traversal
//!     all fail closed here, not in JS),
//!   • everything is staged in a temp dir and published by an atomic directory rename; any error leaves
//!     nothing at the final path (the manifest never reaches `complete`).
//! Media bytes never cross into JS — the copy is host-to-host. Never logs bytes/content paths.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::storage::{read_verified_media, sha256_hex};
use super::MediaError;

pub const BACKUP_FORMAT_VERSION: u32 = 1;

/// One required media file, as selected by the JS `collectRequiredMediaFiles` over the SAME exported DB.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSelection {
    pub scope: String,
    pub hash: String,
    pub extension: String,
    pub byte_size: u64,
    pub media_id: String,
    pub generation_no: i64,
    pub variant_type: Option<String>,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbFileEntry {
    #[serde(rename = "fileName")]
    pub file_name: String,
    #[serde(rename = "byteSize")]
    pub byte_size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    #[serde(rename = "relPath")]
    pub rel_path: String,
    pub hash: String,
    #[serde(rename = "byteSize")]
    pub byte_size: u64,
    #[serde(rename = "mediaId")]
    pub media_id: String,
    #[serde(rename = "generationNo")]
    pub generation_no: i64,
    #[serde(rename = "variantType")]
    pub variant_type: Option<String>,
    pub role: String,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupManifest {
    #[serde(rename = "backupFormatVersion")]
    pub backup_format_version: u32,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "appVersion")]
    pub app_version: String,
    #[serde(rename = "schemaVersion")]
    pub schema_version: String,
    #[serde(rename = "mediaSchemaVersion")]
    pub media_schema_version: String,
    pub db: DbFileEntry,
    #[serde(rename = "additionalDbFiles")]
    pub additional_db_files: Vec<DbFileEntry>,
    pub files: Vec<FileEntry>,
    #[serde(rename = "fileCount")]
    pub file_count: usize,
    pub status: String,
}

/// Build the directory name for a new snapshot from the instant it was taken, expressed in the
/// LOCAL zone with the offset spelled out.
///
/// The id used to be UTC (`snap-2026-08-17T19-42-45-…`), which is defensible — an identifier that
/// shifts with a timezone is not an identifier — but on a machine three hours off UTC it meant the
/// folder said 19:42 for a backup taken at 22:42, with nothing on the name to say so. Carrying the
/// offset in the name gives both: the number you recognise, and no ambiguity about what it means.
///
/// Constraints the shape has to satisfy, all of them load-bearing:
///   • no `:` — illegal in a Windows path, which is why the old id mangled the offset into `-00-00`
///     and made it look like more digits;
///   • the zone is written `UTC+03-00`, so a NEGATIVE offset cannot be misread as a separator;
///   • the sub-second component is kept as the uniqueness nonce (a backup needs a relaunch, so two
///     in one second cannot really happen — but the id must not depend on that being true);
///   • the result stays a single safe path segment, which `restore::is_unsafe_segment` enforces.
///
/// The id is OPAQUE. Nothing parses it: `created_at` in the manifest is the canonical instant, and
/// listing, sorting, retention and restore all read that.
pub fn snapshot_id_for(local: chrono::DateTime<chrono::FixedOffset>) -> String {
    use chrono::Timelike;
    let secs = local.offset().local_minus_utc();
    let sign = if secs < 0 { '-' } else { '+' };
    let abs = secs.abs();
    format!(
        "snap-{}_UTC{}{:02}-{:02}_{:09}",
        local.format("%Y-%m-%dT%H-%M-%S"),
        sign,
        abs / 3600,
        (abs % 3600) / 60,
        local.nanosecond(),
    )
}

pub struct SnapshotInput<'a> {
    pub media_root: &'a Path,
    /// The consistent on-disk frontend DB (`lataif.db`), already durably saved under the caller's lease.
    pub frontend_db: &'a Path,
    /// The embedded server DB (`lataif_sync_server.db`), or None when LAN-sync never ran.
    pub server_db: Option<&'a Path>,
    pub selection: &'a [MediaSelection],
    pub created_at: String,
    pub app_version: String,
    pub schema_version: String,
    pub media_schema_version: String,
    /// The final published backup directory (must NOT already exist).
    pub out_dir: &'a Path,
    /// A workspace parent (temp dir lives here, on the SAME volume as out_dir for an atomic rename).
    pub workspace_parent: &'a Path,
}

/// Rust counterpart of the JS `collectRequiredMediaFiles`: the exact media a valid restore needs, read
/// from an already-consistent DB (active links' master current-gen + active variants' current-gen),
/// deduped by content address. Staging temp files are never selected.
pub fn collect_selection_from_db(conn: &rusqlite::Connection) -> Result<Vec<MediaSelection>, MediaError> {
    let mut out: std::collections::BTreeMap<String, MediaSelection> = std::collections::BTreeMap::new();
    // v0.8.44 — the predicate lives in ONE place. The move verifies against the same two statements,
    // so "the backup considers this complete" and "the move considers this complete" cannot drift.
    let master_sql = super::reachability::REQUIRED_MASTER_SQL;
    let variant_sql = super::reachability::REQUIRED_VARIANT_SQL;
    let mut collect = |sql: &str, is_variant: bool| -> Result<(), MediaError> {
        let mut stmt = conn.prepare(sql).map_err(|e| MediaError::Io(format!("prepare: {}", e)))?;
        let rowset = stmt
            .query_map([], |r| {
                let scope: String = r.get(0)?;
                let media_id: String = r.get(1)?;
                let third: String = r.get(2)?; // media_role (master) OR variant_type (variant)
                let hash: String = r.get(3)?;
                let byte_size: i64 = r.get(4)?;
                let generation_no: i64 = r.get(5)?;
                let extension: String = r.get(6)?;
                Ok((scope, media_id, third, hash, byte_size, generation_no, extension))
            })
            .map_err(|e| MediaError::Io(format!("query: {}", e)))?;
        for row in rowset {
            let (scope, media_id, third, hash, byte_size, generation_no, extension) =
                row.map_err(|e| MediaError::Io(format!("row: {}", e)))?;
            let key = format!("{}|{}", scope, hash);
            out.entry(key).or_insert(MediaSelection {
                scope,
                hash,
                extension,
                byte_size: byte_size as u64,
                media_id,
                generation_no,
                variant_type: if is_variant { Some(third.clone()) } else { None },
                role: if is_variant { "variant".into() } else { third },
            });
        }
        Ok(())
    };
    collect(master_sql, false)?;
    collect(variant_sql, true)?;
    Ok(out.into_values().collect())
}

fn rel_path_for(scope: &str, hash: &str, ext: &str) -> Result<String, MediaError> {
    super::reachability::rel_path_for(scope, hash, ext)
}

/// WAL-checkpoint (TRUNCATE) a SQLite DB so a byte copy of the main file is complete + consistent.
fn checkpoint_server_db(path: &Path) -> Result<(), MediaError> {
    let conn = rusqlite::Connection::open(path).map_err(|e| MediaError::Io(format!("open: {}", e)))?;
    conn.pragma_update(None, "wal_checkpoint", "TRUNCATE")
        .map_err(|e| MediaError::Io(format!("checkpoint: {}", e)))?;
    Ok(())
}

fn copy_db(src: &Path, ws: &Path, name: &str) -> Result<DbFileEntry, MediaError> {
    let bytes = fs::read(src).map_err(|e| MediaError::Io(format!("read db: {}", e)))?;
    fs::write(ws.join(name), &bytes).map_err(|e| MediaError::Io(format!("write db: {}", e)))?;
    Ok(DbFileEntry { file_name: name.to_string(), byte_size: bytes.len() as u64, sha256: sha256_hex(&bytes) })
}

/// Perform the whole snapshot. Returns the `complete` manifest, or an error with NOTHING published.
pub fn snapshot(input: &SnapshotInput) -> Result<BackupManifest, MediaError> {
    if input.out_dir.exists() {
        return Err(MediaError::Io("backup out_dir already exists".into()));
    }
    // Stage into a temp workspace on the same volume; publish by atomic rename at the end.
    let ws: PathBuf = input.workspace_parent.join(format!(
        "backup-ws-{}",
        sha256_hex(input.created_at.as_bytes())[..16].to_string()
    ));
    if ws.exists() {
        fs::remove_dir_all(&ws).ok();
    }
    let result = snapshot_into_workspace(input, &ws);
    match result {
        Ok(manifest) => {
            // Atomic publish: rename the finished workspace to the final directory.
            if let Err(e) = fs::rename(&ws, input.out_dir) {
                fs::remove_dir_all(&ws).ok();
                return Err(MediaError::Io(format!("publish rename: {}", e)));
            }
            Ok(manifest)
        }
        Err(e) => {
            fs::remove_dir_all(&ws).ok(); // fail-closed: discard the partial workspace
            Err(e)
        }
    }
}

fn snapshot_into_workspace(input: &SnapshotInput, ws: &Path) -> Result<BackupManifest, MediaError> {
    fs::create_dir_all(ws).map_err(|e| MediaError::Io(format!("mkdir ws: {}", e)))?;

    // 1. DB snapshots (server DB checkpointed first so its WAL is folded into the main file).
    let db = copy_db(input.frontend_db, ws, "lataif.db")?;
    let mut additional = Vec::new();
    if let Some(server) = input.server_db {
        checkpoint_server_db(server)?;
        additional.push(copy_db(server, ws, "lataif_sync_server.db")?);
    }

    // 2. Media files — read SAFELY (canonical root + no reparse/symlink + hash verify) host-side.
    let mut files = Vec::with_capacity(input.selection.len());
    for sel in input.selection {
        let rel = rel_path_for(&sel.scope, &sel.hash, &sel.extension)?;
        // read_verified_media enforces: containment, no symlink/reparse, exists, and sha256==hash.
        let bytes = read_verified_media(input.media_root, &sel.scope, &sel.hash, &sel.extension)?;
        if bytes.len() as u64 != sel.byte_size {
            return Err(MediaError::FileHashMismatch); // size drift == changed since selection
        }
        let dst = ws.join(&rel);
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| MediaError::Io(format!("mkdir media: {}", e)))?;
        }
        fs::write(&dst, &bytes).map_err(|e| MediaError::Io(format!("write media: {}", e)))?;
        files.push(FileEntry {
            rel_path: rel,
            hash: sel.hash.clone(),
            byte_size: sel.byte_size,
            media_id: sel.media_id.clone(),
            generation_no: sel.generation_no,
            variant_type: sel.variant_type.clone(),
            role: sel.role.clone(),
            scope: sel.scope.clone(),
        });
    }
    files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));

    // 3. Author + write the manifest as `complete` only after every file is staged + verified.
    let manifest = BackupManifest {
        backup_format_version: BACKUP_FORMAT_VERSION,
        created_at: input.created_at.clone(),
        app_version: input.app_version.clone(),
        schema_version: input.schema_version.clone(),
        media_schema_version: input.media_schema_version.clone(),
        db,
        additional_db_files: additional,
        file_count: files.len(),
        files,
        status: "complete".to_string(),
    };
    let json = serde_json::to_vec_pretty(&manifest).map_err(|e| MediaError::Io(format!("manifest: {}", e)))?;
    fs::write(ws.join("manifest.json"), &json).map_err(|e| MediaError::Io(format!("write manifest: {}", e)))?;
    Ok(manifest)
}

// ════════════════════════════════════════════════════════════════════════════
// MOBILE-04B2A12-U2-R1 — boot-scheduled backup. There is NO command that snapshots the live process. The
// owner SCHEDULES a durable intent; the app relaunches; the boot path produces the snapshot while every DB
// is CLOSED (maximally consistent), publishes atomically, and clears the intent exactly once.
// ════════════════════════════════════════════════════════════════════════════

pub const BACKUP_INTENT: &str = ".backup-intent";
const BACKUP_INTENT_TMP: &str = ".backup-intent.tmp";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupIntent {
    pub id: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "appVersion")]
    pub app_version: String,
}

/// Durably record the pending-backup intent via temp → fsync → atomic rename.
pub fn write_backup_intent(app_data_dir: &Path, intent: &BackupIntent) -> Result<(), MediaError> {
    use std::io::Write as _;
    let json = serde_json::to_vec(intent).map_err(|e| MediaError::Io(format!("intent ser: {}", e)))?;
    let tmp = app_data_dir.join(BACKUP_INTENT_TMP);
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| MediaError::Io(format!("intent open: {}", e)))?;
        f.write_all(&json).map_err(|e| MediaError::Io(format!("intent write: {}", e)))?;
        f.sync_all().map_err(|e| MediaError::Io(format!("intent fsync: {}", e)))?;
    }
    fs::rename(&tmp, app_data_dir.join(BACKUP_INTENT))
        .map_err(|e| MediaError::Io(format!("intent rename: {}", e)))
}

fn is_symlink(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

/// Full re-validation of a PUBLISHED backup dir: manifest `complete` + count, and every DB/media file
/// present, not a symlink, with matching size + SHA-256. Returns Err (fail-closed) on any defect — used at
/// boot to decide whether an existing target may be treated as done (so the intent is never consumed for a
/// corrupt/incomplete dir).
pub fn published_is_complete(out_dir: &Path) -> Result<(), MediaError> {
    let raw = fs::read(out_dir.join("manifest.json")).map_err(|_| MediaError::RestoreIncompleteBackup)?;
    let m: BackupManifest =
        serde_json::from_slice(&raw).map_err(|_| MediaError::RestoreIncompleteBackup)?;
    if m.status != "complete" || m.file_count != m.files.len() {
        return Err(MediaError::RestoreIncompleteBackup);
    }
    let check = |rel: &str, size: u64, sha: &str| -> Result<(), MediaError> {
        let abs = out_dir.join(rel);
        if is_symlink(&abs) {
            return Err(MediaError::PathReparsePointForbidden);
        }
        if !abs.exists() {
            return Err(MediaError::FileMissing);
        }
        let bytes = fs::read(&abs).map_err(|e| MediaError::Io(format!("read: {}", e)))?;
        if bytes.len() as u64 != size || sha256_hex(&bytes) != sha {
            return Err(MediaError::FileHashMismatch);
        }
        Ok(())
    };
    check(&m.db.file_name, m.db.byte_size, &m.db.sha256)?;
    for d in &m.additional_db_files {
        check(&d.file_name, d.byte_size, &d.sha256)?;
    }
    for f in &m.files {
        check(&f.rel_path, f.byte_size, &f.hash)?;
    }
    Ok(())
}

/// Read the pending backup intent, or None when absent/corrupt.
pub fn read_backup_intent(app_data_dir: &Path) -> Option<BackupIntent> {
    let raw = fs::read(app_data_dir.join(BACKUP_INTENT)).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// Durably consume the intent (no-op if already gone).
pub fn clear_backup_intent(app_data_dir: &Path) -> Result<(), MediaError> {
    let p = app_data_dir.join(BACKUP_INTENT);
    if p.exists() {
        fs::remove_file(&p).map_err(|e| MediaError::Io(format!("intent clear: {}", e)))?;
    }
    Ok(())
}

/// Boot-time application of a scheduled backup. MUST run before any DB/media file is opened. If an intent
/// exists: produce the snapshot from the closed on-disk DBs and publish atomically, then clear the intent.
/// Exactly-once:
///   • crash BEFORE the snapshot → out_dir absent → the snapshot runs on the next boot (retry),
///   • crash DURING the snapshot → only a temp workspace (keyed by the stable `created_at`) lingers; the
///     next `snapshot()` removes it and rebuilds (temp cleaned + retry) — out_dir never partially exists
///     (it appears only via the final atomic rename),
///   • crash AFTER the atomic publish but before the intent was cleared → out_dir EXISTS → consume the
///     intent without re-snapshotting (no double backup).
pub fn execute_pending_backup(app_data_dir: &Path) -> Result<Option<String>, MediaError> {
    let intent = match read_backup_intent(app_data_dir) {
        Some(i) => i,
        None => return Ok(None),
    };
    // BACKUP-LOCATION — resolve the (possibly owner-configured) backups root. A configured path is used
    // verbatim; if it is on a currently-absent drive, create_dir_all below fails VISIBLY (fail-closed) —
    // it never silently falls back to the default location.
    let backups = super::backup_location::resolve_root(app_data_dir);
    let out_dir = backups.join(&intent.id);
    if out_dir.exists() {
        // A target already exists. Consume the intent ONLY if it is a genuinely complete, fully-valid
        // snapshot (manifest `complete` + every DB/media file present with matching size + SHA-256). An
        // atomic publish never leaves a partial dir, so an INVALID target is an anomaly — fail closed and
        // keep the intent (never a false success, never a blind consume).
        published_is_complete(&out_dir)?;
        clear_backup_intent(app_data_dir)?;
        prune_after_publish(app_data_dir);
        return Ok(Some(intent.id));
    }
    fs::create_dir_all(&backups).map_err(|e| MediaError::Io(format!("mkbackups: {}", e)))?;
    let front = app_data_dir.join("lataif.db");
    let media_root = app_data_dir.join("media");
    let server = app_data_dir.join("lataif_sync_server.db");
    let conn = rusqlite::Connection::open(&front).map_err(|e| MediaError::Io(format!("open front: {}", e)))?;
    let selection = collect_selection_from_db(&conn)?;
    drop(conn);
    let server_opt = if server.exists() { Some(server.as_path()) } else { None };
    let input = SnapshotInput {
        media_root: &media_root,
        frontend_db: &front,
        server_db: server_opt,
        selection: &selection,
        created_at: intent.created_at.clone(),
        app_version: intent.app_version.clone(),
        schema_version: "1".into(),
        media_schema_version: "1".into(),
        out_dir: &out_dir,
        workspace_parent: &backups,
    };
    snapshot(&input)?; // cleans a stale temp ws (same created_at) + publishes `complete` atomically
    clear_backup_intent(app_data_dir)?;
    prune_after_publish(app_data_dir);
    Ok(Some(intent.id))
}

// BACKUP-RETENTION — prune AFTER a fully successful, published snapshot (never before). Best-effort: a
// prune failure is surfaced in the log but NEVER undoes the just-created backup, and it deletes only valid
// complete snapshots beyond the owner-configured "keep last N" (retention is off unless the owner enabled it).
fn prune_after_publish(app_data_dir: &Path) {
    let r = super::backup_retention::prune(app_data_dir);
    if r.enabled {
        eprintln!(
            "backup retention: kept={} deleted={} failed={} skipped_restore_pending={}",
            r.kept, r.deleted, r.failed, r.skipped_restore_pending
        );
    }
}

#[cfg(test)]
#[path = "backup_tests.rs"]
mod backup_tests;
