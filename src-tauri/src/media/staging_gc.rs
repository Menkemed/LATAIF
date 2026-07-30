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

/// DRY-RUN: analyse the allowlisted staging roots and decide which temporary files are SAFELY deletable.
/// Never deletes. Production entry point.
pub fn analyze(app_data_dir: &Path, grace_secs: u64, now: u64) -> Result<GcPlan, MediaError> {
    let root_canon = fs::canonicalize(app_data_dir).map_err(io("app root"))?;
    let op = operation_in_progress(app_data_dir);
    let mut deletable: Vec<GcEntry> = Vec::new();
    let mut retained: Vec<GcRetained> = Vec::new();
    let mut consider = |rel_key: String, abs: PathBuf, referenced: bool| {
        match classify(&root_canon, &abs, op, referenced, grace_secs, now) {
            Some(reason) => retained.push(GcRetained { rel_key, reason: reason.into() }),
            None => deletable.push(GcEntry { byte_size: entry_size(&abs), rel_key }),
        }
    };

    // ── Target 1: backups/backup-ws-* (crashed snapshot workspaces) ──
    let backups = app_data_dir.join("backups");
    if let Ok(rd) = fs::read_dir(&backups) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with(BACKUP_WS_PREFIX) {
                continue; // published `<id>/` dirs are NEVER enumerated → hard-excluded
            }
            // a pending backup intent implies op_in_progress=true (whole-run retain), so its live ws is
            // covered by the guard; `referenced=false` here is only reached when no operation is pending.
            consider(format!("backups/{name}"), e.path(), false);
        }
    }

    // ── Target 2: media/.ingest-journal/*.tmp with no surviving journal entry ──
    let journal_dir = app_data_dir.join("media").join(INGEST_JOURNAL_DIR);
    if let Ok(rd) = fs::read_dir(&journal_dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.ends_with(".tmp") {
                continue; // journal `.json` entries + anything else are NEVER enumerated
            }
            // referenced iff its journal entry still exists (recover() will re-drive it).
            let referenced = match journal_entry_for_tmp(&name) {
                Some(entry) => journal_dir.join(&entry).exists(),
                None => true, // unpar.seable temp name → conservatively retain
            };
            consider(format!("media/{INGEST_JOURNAL_DIR}/{name}"), e.path(), referenced);
        }
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

/// Re-analyse ONE staged file immediately before deletion (TOCTOU): re-reads the operation guard, symlink
/// state, containment, the journal SSOT and the age. Returns true only if it is STILL a proven orphan.
fn still_deletable(app_data_dir: &Path, root_canon: &Path, rel_key: &str, grace_secs: u64, now: u64) -> bool {
    let abs = app_data_dir.join(rel_key);
    let op = operation_in_progress(app_data_dir);
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

/// APPLY the GC (test/e2e ONLY). Re-analyses each file at delete time; a file that became referenced /
/// young / unsafe between the dry-run and now is skipped. A missing file counts as skipped (idempotent,
/// crash-repeatable). A per-file delete error is isolated to that file — it never aborts the run or drives
/// a following deletion.
#[cfg(any(test, feature = "e2e"))]
pub fn apply(app_data_dir: &Path, grace_secs: u64, now: u64) -> Result<GcApplyResult, MediaError> {
    let plan = analyze(app_data_dir, grace_secs, now)?;
    let root_canon = fs::canonicalize(app_data_dir).map_err(io("app root"))?;
    let mut deleted = 0usize;
    let mut skipped = 0usize;
    for d in &plan.deletable {
        if !still_deletable(app_data_dir, &root_canon, &d.rel_key, grace_secs, now) {
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

#[cfg(test)]
#[path = "staging_gc_tests.rs"]
mod staging_gc_tests;
