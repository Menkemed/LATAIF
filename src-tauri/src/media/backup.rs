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

#[derive(Debug, Clone, Serialize)]
pub struct DbFileEntry {
    #[serde(rename = "fileName")]
    pub file_name: String,
    #[serde(rename = "byteSize")]
    pub byte_size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug, Clone, Serialize)]
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
    let master_sql = "SELECT l.tenant_id, l.media_id, l.media_role, g.stored_blob_hash, g.byte_size, g.generation_no, g.extension \
        FROM media_links l \
        JOIN media_objects o ON o.tenant_id=l.tenant_id AND o.media_id=l.media_id AND o.deleted_at IS NULL \
        JOIN media_blobs b ON b.tenant_id=o.tenant_id AND b.blob_id=o.master_blob_id AND b.blob_status='present' \
        JOIN media_blob_generations g ON g.tenant_id=b.tenant_id AND g.blob_id=b.blob_id AND g.generation_no=b.current_generation_no AND g.gen_status='available' \
        WHERE l.deleted_at IS NULL";
    let variant_sql = "SELECT v.tenant_id, v.media_id, v.variant_type, g.stored_blob_hash, g.byte_size, g.generation_no, g.extension \
        FROM media_variants v \
        JOIN media_links l ON l.tenant_id=v.tenant_id AND l.media_id=v.media_id AND l.deleted_at IS NULL \
        JOIN media_blobs b ON b.tenant_id=v.tenant_id AND b.blob_id=v.blob_id AND b.blob_status='present' \
        JOIN media_blob_generations g ON g.tenant_id=b.tenant_id AND g.blob_id=b.blob_id AND g.generation_no=b.current_generation_no AND g.gen_status='available' \
        WHERE v.deleted_at IS NULL";
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
    if hash.len() < 2 || !hash.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(MediaError::PathOutsideRoot);
    }
    Ok(format!("{}/{}/{}.{}", scope, &hash[0..2], hash, ext))
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

#[cfg(test)]
#[path = "backup_tests.rs"]
mod backup_tests;
