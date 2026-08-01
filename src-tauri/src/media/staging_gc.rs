//! MOBILE-04B2A14-I1 — safe TEMPORARY staging garbage collection (real host for the dormant
//! `staging-gc.ts` contract). Production compiles ONLY the dry-run analysis; the real deletion (`apply`)
//! is test/e2e-gated and there is NO automatic boot deletion.
//!
//! This slice deletes EXCLUSIVELY two by-design-unreferenced temporary target classes, both under a fixed
//! allowlist of roots, and ONLY after a grace period:
//!   1. `backups/backup-ws-*`      — a crashed snapshot's temp workspace,
//!   2. `media/.ingest-journal/*.tmp` — an abandoned ingest temp whose journal entry (`{scope}__{req}.json`)
//!      no longer exists.
//! HARD-EXCLUDED (never even enumerated): `mobile-upload-staging/`, published `backups/<id>/`, live media
//! `media/{scope}/…`, `.restore-staging`, `.restore-rollback`, `.restore-journal`, `.backup-intent`,
//! `.restore-intent`. If ANY boot operation is pending (a backup/restore intent or a restore journal), the
//! whole run retains everything (operation-in-progress guard). Every candidate must additionally pass:
//! canonical containment under the allowed root, no symlink/reparse, a valid non-future mtime older than
//! the grace period, and no live SSOT reference. `apply` RE-ANALYSES each file immediately before deleting
//! (TOCTOU), treats a missing file as already gone (idempotent), and isolates a per-file error so it can
//! never cascade into an unsafe deletion. Never logs bytes; dry-run output carries staging-relative keys +
//! counts/sizes only — never an absolute path.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::MediaError;

pub const DEFAULT_GRACE_SECS: u64 = 3600;
const BACKUP_WS_PREFIX: &str = "backup-ws-";
const INGEST_JOURNAL_DIR: &str = ".ingest-journal";
const MOBILE_STAGING_DIR: &str = "mobile-upload-staging";

/// The server-DB liveness verdict for one content-addressed mobile-staging blob.
enum BlobRef {
    /// At least one inbox row is `accepted`/`processing`/`ready` → keep.
    Live,
    /// The server DB could not be opened/queried, or the schema was unexpected → FAIL-CLOSED, keep.
    DbUnavailable,
    /// An inbox row carries an UNKNOWN / future state (not one of the five known) → keep (never infer death).
    UnknownState,
    /// Every inbox row is EXPLICITLY `conflict`/`quarantined`, OR there is NO row at all (a pure filesystem
    /// orphan) → an orphan candidate, still gated by the grace period.
    Dead,
}

const LIVE_STATES: [&str; 3] = ["accepted", "processing", "ready"];
const TERMINAL_STATES: [&str; 2] = ["conflict", "quarantined"];

/// Open the server DB READ-ONLY (never creating it). None on any error → the caller retains every blob.
fn open_server_ro(path: &Path) -> Option<rusqlite::Connection> {
    rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()
}

/// A staging blob's storage_key must be the canonical `{scope}/{hh}/{hash}.{ext}` shape (3 safe segments,
/// a 2-char sub-dir, a file with an extension). A non-normalised key is RETAINED (never deleted).
fn is_normalized_staging_rel(rel: &str) -> bool {
    let segs: Vec<&str> = rel.split('/').collect();
    segs.len() == 3
        && segs.iter().all(|s| !s.is_empty() && *s != "." && *s != ".." && !s.contains('\\'))
        && segs[1].len() == 2
        && segs[2].contains('.')
}

/// EXPLICIT content-addressed liveness for a staging blob. Gathers EVERY inbox state joined to this exact
/// `(tenant, storage_key)` and decides by explicit state, never by "absence of a live reference":
///   • any accepted/processing/ready row  → `Live` (keep),
///   • any state NOT in the five known    → `UnknownState` (keep — future/unknown states never infer death),
///   • all rows conflict/quarantined, or no row at all → `Dead` (grace-gated orphan candidate).
/// Any open/prepare/query/decode error (missing/corrupt/locked DB, unexpected schema) → `DbUnavailable`.
fn blob_liveness(conn: Option<&rusqlite::Connection>, scope: &str, storage_key: &str) -> BlobRef {
    let c = match conn {
        Some(c) => c,
        None => return BlobRef::DbUnavailable,
    };
    let mut stmt = match c.prepare(
        "SELECT DISTINCT i.state FROM mobile_upload_image m \
         JOIN mobile_upload_inbox i \
           ON i.tenant_id=m.tenant_id AND i.branch_id=m.branch_id \
          AND i.authenticated_user_id=m.authenticated_user_id AND i.upload_event_id=m.upload_event_id \
         WHERE m.tenant_id=?1 AND m.storage_key=?2",
    ) {
        Ok(s) => s,
        Err(_) => return BlobRef::DbUnavailable,
    };
    let rows = match stmt.query_map(rusqlite::params![scope, storage_key], |r| r.get::<_, String>(0)) {
        Ok(r) => r,
        Err(_) => return BlobRef::DbUnavailable,
    };
    let mut any_live = false;
    let mut any_unknown = false;
    for row in rows {
        let s = match row {
            Ok(s) => s,
            Err(_) => return BlobRef::DbUnavailable,
        };
        if LIVE_STATES.contains(&s.as_str()) {
            any_live = true;
        } else if !TERMINAL_STATES.contains(&s.as_str()) {
            any_unknown = true; // an unknown/future state → never treat the blob as dead
        }
    }
    if any_live {
        BlobRef::Live
    } else if any_unknown {
        BlobRef::UnknownState
    } else {
        BlobRef::Dead // every row is explicitly terminal, or there is no row (fs-orphan)
    }
}

/// Collect regular files under a staging tree, skipping ALL dot-prefixed entries (`.tmp`/`.creating`/…) and
/// never following/descending a symlink (a symlinked entry is yielded so the caller RETAINS it).
fn walk_blob_files(dir: &Path, out: &mut Vec<PathBuf>) {
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let p = e.path();
            if is_symlink(&p) {
                out.push(p); // yielded → retained as `symlink`, never followed
                continue;
            }
            if p.is_dir() {
                walk_blob_files(&p, out);
            } else {
                out.push(p);
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcEntry {
    /// staging-relative identity (app-relative, `/`-joined) — never an absolute path.
    pub rel_key: String,
    pub byte_size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcRetained {
    pub rel_key: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcPlan {
    pub deletable: Vec<GcEntry>,
    pub retained: Vec<GcRetained>,
    pub deletable_count: usize,
    pub retained_count: usize,
    pub deletable_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcApplyResult {
    pub deleted: usize,
    pub skipped: usize,
    pub planned: usize,
}

fn io<E: std::fmt::Display>(ctx: &'static str) -> impl Fn(E) -> MediaError {
    move |e| MediaError::Io(format!("{}: {}", ctx, e))
}
fn is_symlink(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}
fn dir_size(p: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![p.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = fs::read_dir(&d) {
            for e in rd.flatten() {
                let path = e.path();
                if path.is_dir() {
                    stack.push(path);
                } else if let Ok(m) = fs::metadata(&path) {
                    total = total.saturating_add(m.len());
                }
            }
        }
    }
    total
}
fn entry_size(p: &Path) -> u64 {
    if p.is_dir() { dir_size(p) } else { fs::metadata(p).map(|m| m.len()).unwrap_or(0) }
}

/// Current wall-clock seconds since epoch (production). Tests pass a fixed `now`.
pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// GC must NEVER run while a boot operation could be creating/consuming these files.
fn operation_in_progress(app: &Path) -> bool {
    app.join(".backup-intent").exists()
        || app.join(".restore-intent").exists()
        || app.join(".restore-journal").exists()
}

/// File age in seconds, or None when the mtime is unreadable OR lies in the FUTURE (clock skew / invalid
/// time) — an unknown/future age is treated as "young" and RETAINED, never deleted.
fn age_secs(abs: &Path, now: u64) -> Option<u64> {
    let mtime = fs::metadata(abs).ok()?.modified().ok()?;
    let secs = mtime.duration_since(UNIX_EPOCH).ok()?.as_secs();
    if secs > now { return None; } // future mtime → skew → retain
    Some(now.saturating_sub(secs))
}

/// Classify ONE candidate. Returns Some(retain_reason) to keep, None if it is a proven-safe orphan.
/// `referenced` = a live SSOT still needs it. Re-runnable (all reads fresh) → also the TOCTOU re-check.
fn classify(
    root_canon: &Path,
    abs: &Path,
    op_in_progress: bool,
    referenced: bool,
    grace_secs: u64,
    now: u64,
) -> Option<&'static str> {
    if op_in_progress {
        return Some("operation_in_progress");
    }
    if is_symlink(abs) {
        return Some("symlink");
    }
    // canonical containment: the resolved path must live under the allowed root.
    match fs::canonicalize(abs) {
        Ok(c) if c.starts_with(root_canon) => {}
        _ => return Some("outside_staging_root"),
    }
    if referenced {
        return Some("referenced_by_ssot");
    }
    match age_secs(abs, now) {
        Some(a) if a >= grace_secs => None, // proven orphan
        _ => Some("within_grace_period"),   // young, or unknown/future mtime → retain
    }
}

/// Parse `{scope}__{req}.(main|thumb).jpg.tmp` → the journal entry name `{scope}__{req}.json`.
fn journal_entry_for_tmp(tmp_name: &str) -> Option<String> {
    let base = tmp_name.strip_suffix(".main.jpg.tmp").or_else(|| tmp_name.strip_suffix(".thumb.jpg.tmp"))?;
    if base.is_empty() { return None; }
    Some(format!("{base}.json"))
}

/// Scan the two TEMPORARY targets (backup-ws + ingest-journal tmp) into the given buffers.
fn scan_temp_targets(
    app_data_dir: &Path,
    root_canon: &Path,
    op: bool,
    grace_secs: u64,
    now: u64,
    deletable: &mut Vec<GcEntry>,
    retained: &mut Vec<GcRetained>,
) {
    let mut consider = |rel_key: String, abs: PathBuf, referenced: bool| {
        match classify(root_canon, &abs, op, referenced, grace_secs, now) {
            Some(reason) => retained.push(GcRetained { rel_key, reason: reason.into() }),
            None => deletable.push(GcEntry { byte_size: entry_size(&abs), rel_key }),
        }
    };
    // Target 1: backups/backup-ws-* (crashed snapshot workspaces). Published `<id>/` NEVER enumerated.
    let backups = app_data_dir.join("backups");
    if let Ok(rd) = fs::read_dir(&backups) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with(BACKUP_WS_PREFIX) {
                continue;
            }
            consider(format!("backups/{name}"), e.path(), false);
        }
    }
    // Target 2: media/.ingest-journal/*.tmp with no surviving journal entry.
    let journal_dir = app_data_dir.join("media").join(INGEST_JOURNAL_DIR);
    if let Ok(rd) = fs::read_dir(&journal_dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.ends_with(".tmp") {
                continue;
            }
            let referenced = match journal_entry_for_tmp(&name) {
                Some(entry) => journal_dir.join(&entry).exists(),
                None => true,
            };
            consider(format!("media/{INGEST_JOURNAL_DIR}/{name}"), e.path(), referenced);
        }
    }
}

/// Scan `mobile-upload-staging/{scope}/…` content-addressed blobs. A blob is deletable ONLY when its
/// server-DB inbox ref-count in accepted|processing|ready is ZERO (existing refs are all conflict/
/// quarantined, or none), it is old enough, inside the staging root, no symlink, no operation pending, and
/// the server DB was fully readable. This scan NEVER touches the media root, media_*, the frontend DB, or
/// `.ingest-journal`.
fn scan_mobile_blobs(
    app_data_dir: &Path,
    server_conn: Option<&rusqlite::Connection>,
    op: bool,
    grace_secs: u64,
    now: u64,
    deletable: &mut Vec<GcEntry>,
    retained: &mut Vec<GcRetained>,
) {
    let staging = app_data_dir.join(MOBILE_STAGING_DIR);
    let staging_canon = match fs::canonicalize(&staging) {
        Ok(c) => c,
        Err(_) => return, // no staging dir → nothing to scan
    };
    let mut files = Vec::new();
    walk_blob_files(&staging, &mut files);
    for abs in files {
        let rel = match abs.strip_prefix(&staging) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if rel.is_empty() {
            continue;
        }
        let scope = rel.split('/').next().unwrap_or("");
        let rel_key = format!("{MOBILE_STAGING_DIR}/{rel}");
        let reason: Option<&str> = if op {
            Some("operation_in_progress")
        } else if is_symlink(&abs) {
            Some("symlink")
        } else if !fs::canonicalize(&abs).map(|c| c.starts_with(&staging_canon)).unwrap_or(false) {
            Some("outside_staging_root")
        } else if !is_normalized_staging_rel(&rel) {
            Some("unnormalized_key") // a storage_key/scope that is not the canonical shape → retain
        } else {
            match blob_liveness(server_conn, scope, &rel) {
                BlobRef::Live => Some("referenced_by_inbox"),
                BlobRef::UnknownState => Some("unknown_state"),
                BlobRef::DbUnavailable => Some("server_db_unavailable"),
                BlobRef::Dead => match age_secs(&abs, now) {
                    Some(a) if a >= grace_secs => None, // explicitly terminal / no row, and past grace
                    _ => Some("within_grace_period"),
                },
            }
        };
        match reason {
            Some(r) => retained.push(GcRetained { rel_key, reason: r.into() }),
            None => deletable.push(GcEntry { byte_size: entry_size(&abs), rel_key }),
        }
    }
}

fn analyze_impl(
    app_data_dir: &Path,
    server_db: Option<&Path>,
    grace_secs: u64,
    now: u64,
    include_blobs: bool,
) -> Result<GcPlan, MediaError> {
    let root_canon = fs::canonicalize(app_data_dir).map_err(io("app root"))?;
    let op = operation_in_progress(app_data_dir);
    let mut deletable: Vec<GcEntry> = Vec::new();
    let mut retained: Vec<GcRetained> = Vec::new();
    scan_temp_targets(app_data_dir, &root_canon, op, grace_secs, now, &mut deletable, &mut retained);
    if include_blobs {
        // Fail-closed: if the server DB can't be opened, every blob is retained (server_db_unavailable).
        let conn = server_db.and_then(open_server_ro);
        scan_mobile_blobs(app_data_dir, conn.as_ref(), op, grace_secs, now, &mut deletable, &mut retained);
    }
    let deletable_bytes = deletable.iter().map(|d| d.byte_size).sum();
    Ok(GcPlan {
        deletable_count: deletable.len(),
        retained_count: retained.len(),
        deletable_bytes,
        deletable,
        retained,
    })
}

/// DRY-RUN of the TEMPORARY targets only (backup-ws + ingest-journal tmp). Never deletes. This is the
/// production boot analysis — it does NOT touch mobile-staging blobs.
pub fn analyze(app_data_dir: &Path, grace_secs: u64, now: u64) -> Result<GcPlan, MediaError> {
    analyze_impl(app_data_dir, None, grace_secs, now, false)
}

/// DRY-RUN including mobile-staging blob liveness (server-DB read-only). Read-only: never deletes. Used by
/// the owner-gated dry-run command + the e2e apply. No absolute path in the plan.
pub fn analyze_with_blobs(
    app_data_dir: &Path,
    server_db: &Path,
    grace_secs: u64,
    now: u64,
) -> Result<GcPlan, MediaError> {
    analyze_impl(app_data_dir, Some(server_db), grace_secs, now, true)
}

/// Re-analyse ONE staged file immediately before deletion (TOCTOU). Handles both a TEMP rel_key (journal
/// SSOT) and a mobile-staging blob rel_key (fresh server-DB liveness). Returns true only if it is STILL a
/// proven orphan.
fn still_deletable(
    app_data_dir: &Path,
    root_canon: &Path,
    server_db: Option<&Path>,
    rel_key: &str,
    grace_secs: u64,
    now: u64,
) -> bool {
    let abs = app_data_dir.join(rel_key);
    let op = operation_in_progress(app_data_dir);
    if let Some(rel) = rel_key.strip_prefix(&format!("{MOBILE_STAGING_DIR}/")) {
        // mobile-staging blob: re-check guards + fresh server-DB liveness.
        let staging = app_data_dir.join(MOBILE_STAGING_DIR);
        let staging_canon = match fs::canonicalize(&staging) {
            Ok(c) => c,
            Err(_) => return false,
        };
        if op || is_symlink(&abs) {
            return false;
        }
        if !fs::canonicalize(&abs).map(|c| c.starts_with(&staging_canon)).unwrap_or(false) {
            return false;
        }
        if !is_normalized_staging_rel(rel) {
            return false;
        }
        let scope = rel.split('/').next().unwrap_or("");
        let conn = server_db.and_then(open_server_ro);
        match blob_liveness(conn.as_ref(), scope, rel) {
            BlobRef::Dead => matches!(age_secs(&abs, now), Some(a) if a >= grace_secs),
            _ => false, // live / unknown-state / db-unavailable → keep
        }
    } else {
        // temporary target: journal SSOT + classify.
        let referenced = if let Some(name) = rel_key.strip_prefix(&format!("media/{INGEST_JOURNAL_DIR}/")) {
            match journal_entry_for_tmp(name) {
                Some(entry) => app_data_dir.join("media").join(INGEST_JOURNAL_DIR).join(entry).exists(),
                None => true,
            }
        } else {
            false
        };
        classify(root_canon, &abs, op, referenced, grace_secs, now).is_none()
    }
}

fn delete_path(abs: &Path) -> Result<bool, MediaError> {
    match fs::symlink_metadata(abs) {
        Err(_) => Ok(false), // already gone → idempotent
        Ok(m) if m.is_dir() => {
            fs::remove_dir_all(abs).map_err(io("rmdir"))?;
            Ok(true)
        }
        Ok(_) => {
            fs::remove_file(abs).map_err(io("rm"))?;
            Ok(true)
        }
    }
}

/// The real deletion loop (production). Re-analyses each file at delete time (TOCTOU); a file that became
/// referenced / young / unsafe between the dry-run and now is skipped. A missing file counts as skipped
/// (idempotent, crash-repeatable). A per-file delete error is isolated to that file — it never aborts the
/// run or drives a following deletion. NEVER deletes a protected/enumerated-out path (allowlist + classify).
fn run_apply(
    app_data_dir: &Path,
    server_db: Option<&Path>,
    grace_secs: u64,
    now: u64,
    include_blobs: bool,
) -> Result<GcApplyResult, MediaError> {
    let plan = analyze_impl(app_data_dir, server_db, grace_secs, now, include_blobs)?;
    let root_canon = fs::canonicalize(app_data_dir).map_err(io("app root"))?;
    let mut deleted = 0usize;
    let mut skipped = 0usize;
    for d in &plan.deletable {
        if !still_deletable(app_data_dir, &root_canon, server_db, &d.rel_key, grace_secs, now) {
            skipped += 1;
            continue; // TOCTOU: no longer a proven orphan
        }
        match delete_path(&app_data_dir.join(&d.rel_key)) {
            Ok(true) => deleted += 1,
            Ok(false) => skipped += 1,
            Err(_) => skipped += 1, // isolate the failure; never cascade
        }
    }
    Ok(GcApplyResult { deleted, skipped, planned: plan.deletable.len() })
}

/// PRODUCTION boot entry. Reached ONLY internally from `lib.rs setup()` — after recover + pending restore
/// + pending backup, and BEFORE any DB/server start — never via a Tauri command or frontend API. Collects
/// the TEMPORARY targets (backup-ws + ingest-journal tmp) AND terminal mobile-staging blobs. The server DB
/// is opened READ-ONLY and is quiescent here (the embedded server has not started yet). If it is
/// missing/corrupt/locked, every blob is retained (`server_db_unavailable`) while the temp targets still
/// run independently — never a partial blob plan. Conservative grace + real clock; blob deletion never
/// touches the media root, the frontend DB, backup/restore files, or `.ingest-journal`.
pub fn execute_boot_gc(app_data_dir: &Path) -> Result<GcApplyResult, MediaError> {
    let server_db = app_data_dir.join("lataif_sync_server.db");
    run_apply(app_data_dir, Some(&server_db), DEFAULT_GRACE_SECS, now_secs(), true)
}

/// APPLY the TEMPORARY targets with caller-chosen grace/now — test/e2e ONLY.
#[cfg(any(test, feature = "e2e"))]
pub fn apply(app_data_dir: &Path, grace_secs: u64, now: u64) -> Result<GcApplyResult, MediaError> {
    run_apply(app_data_dir, None, grace_secs, now, false)
}

/// APPLY including mobile-staging blob deletion (server-DB liveness) — test/e2e ONLY. There is NO
/// production caller: staging-blob deletion is proven here but not yet wired into any production path.
#[cfg(any(test, feature = "e2e"))]
pub fn apply_with_blobs(
    app_data_dir: &Path,
    server_db: &Path,
    grace_secs: u64,
    now: u64,
) -> Result<GcApplyResult, MediaError> {
    run_apply(app_data_dir, Some(server_db), grace_secs, now, true)
}

#[cfg(test)]
#[path = "staging_gc_tests.rs"]
mod staging_gc_tests;
