//! RESTORE-SAFETY — what a restore of one snapshot would change, READ-ONLY.
//!
//! Compares the snapshot's frontend DB with the live one (the last SAVED state on disk) and the snapshot's
//! manifest with the live media folder. Nothing is written, nothing is locked for writing. Every number is
//! exact for what it says; what is NOT compared (field changes inside a record that exists on both sides,
//! tables outside the list) is reported as not determined — `None`, never a guessed number.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use serde::Serialize;

use super::restore::{resolve_snapshot_id, staged_bytes, validate_snapshot};
use super::restore_archive as ra;
use super::MediaError;

/// The business tables whose records are compared by id.
const TABLES: &[&str] = &[
    "products", "customers", "suppliers", "purchases", "invoices", "repairs", "consignments", "orders",
    "offers", "expenses", "payments",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordDiff {
    pub table: String,
    /// Records that exist now but not in the snapshot — lost by the restore. `None` = not determined.
    pub lost: Option<u64>,
    /// Records in the snapshot that no longer exist now — they come back. `None` = not determined.
    pub returning: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub snapshot_id: String,
    pub snapshot_created_at: String,
    pub snapshot_app_version: String,
    /// The live DB was found and read (its last saved state).
    pub live_db_read: bool,
    pub records: Vec<RecordDiff>,
    /// Field changes inside records that exist on both sides are NOT compared.
    pub field_changes_compared: bool,
    /// Gallery photos active in the snapshot but not active now — visible again after the restore.
    pub photos_visible_again: Option<u64>,
    /// Gallery photos active now but not in the snapshot — they leave the galleries (their files are archived).
    pub photos_leaving: Option<u64>,
    /// Files now in the media folder that the snapshot does not carry — they move into the archive (kept).
    pub media_files_not_in_snapshot: u64,
    pub media_bytes_not_in_snapshot: u64,
    /// Files the snapshot's DB lists without carrying them, proven in the current media — copied back.
    pub files_filled_in: Option<u64>,
    /// Files the snapshot's DB lists that exist nowhere — they stay without a file.
    pub files_still_missing: Option<u64>,
    /// The archive this restore would create holds the whole current state (DBs + media).
    pub archive_files: u64,
    pub archive_bytes: u64,
    pub space_needed_bytes: u64,
    pub space_free_bytes: Option<u64>,
    pub archives_existing: u64,
    pub archives_existing_bytes: u64,
}

fn open_ro(p: &Path) -> Option<rusqlite::Connection> {
    if !p.exists() {
        return None;
    }
    rusqlite::Connection::open_with_flags(p, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()
}

fn ids(conn: &rusqlite::Connection, sql: &str) -> Option<BTreeSet<String>> {
    let mut stmt = conn.prepare(sql).ok()?;
    let rows = stmt.query_map([], |r| r.get::<_, rusqlite::types::Value>(0)).ok()?;
    let mut out = BTreeSet::new();
    for r in rows {
        let v = r.ok()?;
        out.insert(match v {
            rusqlite::types::Value::Text(s) => s,
            rusqlite::types::Value::Integer(i) => i.to_string(),
            other => format!("{:?}", other),
        });
    }
    Some(out)
}

fn walk_files(root: &Path) -> Vec<(String, u64)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if fs::symlink_metadata(&p).map(|m| m.file_type().is_symlink()).unwrap_or(true) {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(m) = fs::metadata(&p) {
                let rel = p.strip_prefix(root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
                out.push((rel, m.len()));
            }
        }
    }
    out
}

/// The preview for one snapshot id, against the live data root. Read-only.
pub fn preview(app_data_dir: &Path, snapshot_id: &str) -> Result<RestorePreview, MediaError> {
    let backup_dir = resolve_snapshot_id(app_data_dir, snapshot_id)?;
    let manifest = validate_snapshot(&backup_dir)?;
    let snap_db = open_ro(&backup_dir.join(&manifest.db.file_name));
    let live_db = open_ro(&app_data_dir.join(ra::FRONT_DB));

    // ── records ──
    let mut records = Vec::new();
    for t in TABLES {
        let sql = format!("SELECT id FROM {t}");
        let (now, then) = match (&live_db, &snap_db) {
            (Some(l), Some(s)) => (ids(l, &sql), ids(s, &sql)),
            _ => (None, None),
        };
        let (lost, returning) = match (now, then) {
            (Some(n), Some(s)) => (Some(n.difference(&s).count() as u64), Some(s.difference(&n).count() as u64)),
            _ => (None, None),
        };
        records.push(RecordDiff { table: t.to_string(), lost, returning });
    }

    // ── gallery photos (active links) ──
    let active = "SELECT tenant_id || '/' || link_id FROM media_links WHERE deleted_at IS NULL";
    let (photos_visible_again, photos_leaving) = match (live_db.as_ref().and_then(|c| ids(c, active)), snap_db.as_ref().and_then(|c| ids(c, active))) {
        (Some(n), Some(s)) => (Some(s.difference(&n).count() as u64), Some(n.difference(&s).count() as u64)),
        _ => (None, None),
    };

    // ── media files ──
    let live_media = app_data_dir.join("media");
    let in_snapshot: BTreeSet<String> = manifest.files.iter().map(|f| f.rel_path.clone()).collect();
    let mut not_in = (0u64, 0u64);
    for (rel, len) in walk_files(&live_media) {
        if !in_snapshot.contains(&rel) {
            not_in.0 += 1;
            not_in.1 += len;
        }
    }
    let (files_filled_in, files_still_missing, fill_bytes) = match snap_db {
        Some(_) => {
            // The snapshot DB's rows checked against its own files (as staged) and the current media.
            let staged_media = backup_dir.clone();
            match ra::plan_fill_in(&backup_dir.join(&manifest.db.file_name), &staged_media, &live_media, true) {
                Ok((plan, rep)) => (Some(plan.len() as u64), Some(rep.source_missing + rep.refused), plan.iter().map(|p| p.bytes).sum::<u64>()),
                Err(_) => (None, None, 0),
            }
        }
        None => (None, None, 0),
    };

    // ── the archive this restore would create = everything set aside now ──
    let mut archive = (0u64, 0u64);
    for name in std::iter::once(manifest.db.file_name.clone()).chain(manifest.additional_db_files.iter().map(|d| d.file_name.clone())) {
        for suffix in ["", "-wal", "-shm"] {
            if let Ok(m) = fs::metadata(app_data_dir.join(format!("{name}{suffix}"))) {
                archive.0 += 1;
                archive.1 += m.len();
            }
        }
    }
    for (_, len) in walk_files(&live_media) {
        archive.0 += 1;
        archive.1 += len;
    }

    let (archives_existing, archives_existing_bytes) = ra::archives_size(app_data_dir);
    Ok(RestorePreview {
        snapshot_id: snapshot_id.to_string(),
        snapshot_created_at: manifest.created_at.clone(),
        snapshot_app_version: manifest.app_version.clone(),
        live_db_read: live_db.is_some(),
        records,
        field_changes_compared: false,
        photos_visible_again,
        photos_leaving,
        media_files_not_in_snapshot: not_in.0,
        media_bytes_not_in_snapshot: not_in.1,
        files_filled_in,
        files_still_missing,
        archive_files: archive.0,
        archive_bytes: archive.1,
        space_needed_bytes: ra::with_margin(staged_bytes(&manifest) + fill_bytes),
        space_free_bytes: ra::volume_free(app_data_dir),
        archives_existing,
        archives_existing_bytes,
    })
}
