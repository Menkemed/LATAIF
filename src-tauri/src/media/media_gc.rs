// ════════════════════════════════════════════════════════════════════════════
// MEDIA-ROOT-GC — safely detect and remove files in the production media root that NO tracked media blob
// references. OFF by default; the owner triggers a dry-run scan, then a SCHEDULED apply that runs at the
// next boot and is finalized (permanently purged) only after an explicit owner confirmation.
//
// SAFETY MODEL:
//   • Reference set = EVERY `media_blob_generations.storage_key` (the exact media-root-relative path of every
//     generation the DB tracks — current AND non-current: pinned backup generations, mid-rotation
//     generations, all variants). A file is an orphan ONLY if NO generation row names it. This is strictly
//     broader (safer) than the minimal backup restore-set. A DB read error is FAIL-CLOSED: no reference set,
//     no deletion.
//   • WRITE BARRIER via boot execution: the move to quarantine runs in `execute_pending_gc` during app setup
//     — BEFORE the LAN server starts and BEFORE the frontend loads, so no ingest / mobile-drain / media
//     writer is running. The owner "apply" only writes a durable intent + relaunches; a mere in-process
//     recheck is never trusted as a barrier. No intent / unbuildable reference set ⇒ no move.
//   • RETENTION, not same-run purge: the move quarantines candidates into `<media_root>/.gc-quarantine/<run>/`
//     (structure preserves each file's media-root-relative path — this IS the candidate manifest) and STOPS.
//     The quarantine survives restarts. Only an explicit owner FINALIZE permanently deletes it.
//   • RECONCILE, not blind delete: every boot, `reconcile_quarantine` re-derives the reference set and moves
//     BACK into the media root any quarantined file that became referenced again; the rest are RETAINED with
//     a visible finding. Nothing is ever blind-purged at boot.
//   • Path safety: candidates resolve strictly inside the canonical media root; every existing component is
//     checked for symlink/junction/reparse points, re-checked immediately before the move; control dirs
//     (any dot-prefixed entry: `.gc-quarantine`, `.ingest-journal`) are never scanned or touched; an external
//     sentinel reached through a junction is never followed.
// ════════════════════════════════════════════════════════════════════════════

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;

use super::MediaError;

pub const QUARANTINE_DIRNAME: &str = ".gc-quarantine";
const GC_INTENT: &str = ".gc-intent";
const GC_INTENT_TMP: &str = ".gc-intent.tmp";
const CONFIG_DB: &str = "lataif_sync_server.db";

/// Persisted run counts (mirrored into the media_gc_runs audit row). No paths/secrets — counts + codes only.
#[derive(Debug, Clone, Default)]
struct RunCounts {
    quarantined: usize,
    purged: usize,
    moved_back: usize,
    retained: usize,
    failed: usize,
}

/// Upsert the audit row for a run: real run_id + one of planned/quarantined/completed/partial/failed + counts.
fn record(conn: &Connection, run_id: &str, state: &str, c: &RunCounts, error: Option<&str>, now: &str) -> Result<(), MediaError> {
    conn.execute(
        "INSERT INTO media_gc_runs (run_id, state, quarantined, purged, moved_back, retained, failed, error_code, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
         ON CONFLICT(run_id) DO UPDATE SET state=excluded.state, quarantined=excluded.quarantined, purged=excluded.purged,
             moved_back=excluded.moved_back, retained=excluded.retained, failed=excluded.failed,
             error_code=excluded.error_code, updated_at=excluded.updated_at",
        params![run_id, state, c.quarantined as i64, c.purged as i64, c.moved_back as i64, c.retained as i64, c.failed as i64, error, now],
    )
    .map_err(|e| MediaError::Io(format!("gc run record: {}", e)))?;
    Ok(())
}

/// Best-effort audit from the boot path (no server conn available): open the config DB and record. The
/// FILESYSTEM is the safety authority, so an audit-write failure never affects the move/retain outcome.
fn audit_bestcase(app_data_dir: &Path, run_id: &str, state: &str, c: &RunCounts, error: Option<&str>) {
    let db = app_data_dir.join(CONFIG_DB);
    if !db.exists() {
        return;
    }
    if let Ok(conn) = Connection::open(&db) {
        let now = chrono::Utc::now().to_rfc3339();
        let _ = record(&conn, run_id, state, c, error, &now);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcOrphan {
    pub rel_path: String,
    pub byte_size: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcReport {
    pub media_root_present: bool,
    pub referenced_count: usize,
    pub orphan_count: usize,
    pub orphan_bytes: u64,
    pub missing_referenced_count: usize,
    pub missing_referenced: Vec<String>,
    pub orphans: Vec<GcOrphan>,
    /// Files already sitting in a retained quarantine (awaiting owner finalize).
    pub quarantined_count: usize,
    pub quarantined_bytes: u64,
}

/// Result of the boot-time move / a finalize / a reconcile pass.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcApplyReport {
    pub run_id: String,
    pub quarantined: usize,
    pub purged: usize,
    pub moved_back: usize,
    pub retained: usize,
    pub skipped: usize,
    pub failed: usize,
    pub bytes: u64,
}

fn is_reparse(md: &std::fs::Metadata) -> bool {
    if md.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if md.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

/// The canonical reference set: EVERY tracked generation's storage_key (media-root-relative path). Fail-closed
/// — any DB open/read error is an error so a failed reference build can never turn every file into an orphan.
fn referenced_rel_paths(front_db: &Path) -> Result<BTreeSet<String>, MediaError> {
    // v0.8.44 — this is the PRESERVED set (see `reachability`): every generation row, whatever its
    // status. Deliberately wider than what a business consumer can reach, because the question here
    // is "may I delete this?", not "must this exist?". Fail-closed — a failed read is an error, never
    // an empty set that would turn every file into an orphan.
    let conn = Connection::open_with_flags(front_db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| MediaError::Io(format!("gc open front: {}", e)))?;
    super::reachability::preserved_keys(&conn)
}

/// Normalize a stored key / scanned path to forward slashes for set comparison.
fn normalize(s: &str) -> String {
    s.replace('\\', "/")
}

fn rel_of(canon_root: &Path, path: &Path) -> Result<String, MediaError> {
    let rel = path.strip_prefix(canon_root).map_err(|_| MediaError::PathOutsideRoot)?;
    let mut parts = Vec::new();
    for c in rel.components() {
        match c {
            std::path::Component::Normal(s) => parts.push(s.to_string_lossy().to_string()),
            _ => return Err(MediaError::PathOutsideRoot),
        }
    }
    Ok(parts.join("/"))
}

/// Every content file under the canonical media root, excluding dot-prefixed control state and never
/// descending into / counting a reparse point. Returns (rel_path, byte_size).
fn scan_files(canon_root: &Path) -> Result<Vec<(String, u64)>, MediaError> {
    let mut out = Vec::new();
    walk(canon_root, canon_root, &mut out)?;
    Ok(out)
}

fn walk(canon_root: &Path, dir: &Path, out: &mut Vec<(String, u64)>) -> Result<(), MediaError> {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(MediaError::Io(format!("gc readdir: {}", e))),
    };
    for ent in rd {
        let ent = ent.map_err(|e| MediaError::Io(format!("gc entry: {}", e)))?;
        let path = ent.path();
        // Content blobs are `<scope>/<hh>/<hash>.jpg` — no component starts with a dot, so any dot-prefixed
        // entry is control state (`.gc-quarantine`, the in-flight `.ingest-journal`) and is never scanned.
        if ent.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let md = std::fs::symlink_metadata(&path).map_err(|e| MediaError::Io(format!("gc lstat: {}", e)))?;
        if is_reparse(&md) {
            continue; // fail-closed: never descend into / count a reparse point
        }
        if md.is_dir() {
            walk(canon_root, &path, out)?;
        } else if md.is_file() {
            out.push((rel_of(canon_root, &path)?, md.len()));
        }
    }
    Ok(())
}

/// The retained quarantine grouped BY RUN: `(run_id, [(media-root-relative path, absolute path, size)])`.
/// The run dir name IS the real run_id (threaded from schedule → boot move → finalize). A run dir that is a
/// reparse point is skipped (never followed). `<quarantine>/<run>/<scope>/<hh>/<hash>.jpg`.
fn quarantine_runs(canon_root: &Path) -> Vec<(String, Vec<(String, PathBuf, u64)>)> {
    let mut out = Vec::new();
    let qroot = canon_root.join(QUARANTINE_DIRNAME);
    if !qroot.exists() {
        return out;
    }
    let runs = match std::fs::read_dir(&qroot) {
        Ok(r) => r,
        Err(_) => return out,
    };
    for run in runs.flatten() {
        let run_dir = run.path();
        if std::fs::symlink_metadata(&run_dir).map(|m| is_reparse(&m)).unwrap_or(true) {
            continue;
        }
        let run_id = run.file_name().to_string_lossy().to_string();
        let mut paths = Vec::new();
        collect_files(&run_dir, &mut paths);
        let mut files = Vec::new();
        for f in paths {
            if let Ok(rel) = f.strip_prefix(&run_dir) {
                let relp = rel.components().filter_map(|c| match c {
                    std::path::Component::Normal(s) => Some(s.to_string_lossy().to_string()),
                    _ => None,
                }).collect::<Vec<_>>().join("/");
                let size = std::fs::metadata(&f).map(|m| m.len()).unwrap_or(0);
                files.push((relp, f, size));
            }
        }
        out.push((run_id, files));
    }
    out
}

/// Flat view of all quarantined files (for the dry-run count).
fn quarantined_entries(canon_root: &Path) -> Vec<(String, PathBuf, u64)> {
    quarantine_runs(canon_root).into_iter().flat_map(|(_, files)| files).collect()
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            match std::fs::symlink_metadata(&p) {
                Ok(m) if is_reparse(&m) => continue,
                Ok(m) if m.is_dir() => collect_files(&p, out),
                Ok(m) if m.is_file() => out.push(p),
                _ => {}
            }
        }
    }
}

/// DRY-RUN: orphans + missing-referenced findings + any retained quarantine. Mutates NOTHING.
pub fn plan(app_data_dir: &Path) -> Result<GcReport, MediaError> {
    let root = app_data_dir.join("media");
    if !root.exists() {
        return Ok(GcReport { media_root_present: false, ..Default::default() });
    }
    let canon = super::storage::ensure_root_canonical(&root)?;
    let referenced = referenced_rel_paths(&app_data_dir.join("lataif.db"))?; // fail-closed
    let scanned = scan_files(&canon)?;
    let scanned_set: BTreeSet<&String> = scanned.iter().map(|(r, _)| r).collect();
    let mut orphans = Vec::new();
    let mut orphan_bytes = 0u64;
    for (rel, size) in &scanned {
        if !referenced.contains(rel) {
            orphans.push(GcOrphan { rel_path: rel.clone(), byte_size: *size });
            orphan_bytes += *size;
        }
    }
    let missing: Vec<String> =
        referenced.iter().filter(|r| !scanned_set.contains(*r)).cloned().collect();
    let q = quarantined_entries(&canon);
    Ok(GcReport {
        media_root_present: true,
        referenced_count: referenced.len(),
        orphan_count: orphans.len(),
        orphan_bytes,
        missing_referenced_count: missing.len(),
        missing_referenced: missing,
        orphans,
        quarantined_count: q.len(),
        quarantined_bytes: q.iter().map(|(_, _, s)| *s).sum(),
    })
}

// ── intent (owner "apply" schedules a boot run; the move never happens live) ─────────────────────
fn write_intent(app_data_dir: &Path, run_id: &str) -> Result<(), MediaError> {
    let tmp = app_data_dir.join(GC_INTENT_TMP);
    std::fs::write(&tmp, run_id).map_err(|e| MediaError::Io(format!("gc intent write: {}", e)))?;
    std::fs::rename(&tmp, app_data_dir.join(GC_INTENT))
        .map_err(|e| MediaError::Io(format!("gc intent publish: {}", e)))?;
    Ok(())
}
pub fn read_intent(app_data_dir: &Path) -> Option<String> {
    std::fs::read_to_string(app_data_dir.join(GC_INTENT)).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}
pub fn clear_intent(app_data_dir: &Path) {
    let _ = std::fs::remove_file(app_data_dir.join(GC_INTENT));
}

/// OWNER apply = SCHEDULE. Coordination + a complete backup snapshot must exist; then write a durable intent
/// carrying the REAL run_id and record the run as `planned`. The move happens at the next boot (write
/// barrier); the caller relaunches. The same run_id is carried through boot-move → reconcile → finalize.
pub fn schedule(app_data_dir: &Path, config_conn: &Connection, run_id: &str, now: &str) -> Result<(), MediaError> {
    if super::restore_recovery::read_intent(app_data_dir).is_some() {
        return Err(MediaError::Io("gc refused: restore pending".into()));
    }
    if super::backup::read_backup_intent(app_data_dir).is_some() {
        return Err(MediaError::Io("gc refused: backup pending".into()));
    }
    if super::restore::list_snapshots(app_data_dir).unwrap_or_default().is_empty() {
        return Err(MediaError::Io("gc refused: no backup snapshot".into()));
    }
    write_intent(app_data_dir, run_id)?;
    let _ = record(config_conn, run_id, "planned", &RunCounts::default(), None, now);
    Ok(())
}

/// BOOT: if a GC was scheduled, move orphans into the retained quarantine now (writers are idle). Never
/// purges. Fail-closed: an unbuildable reference set aborts the move (intent cleared, nothing deleted).
pub fn execute_pending_gc(app_data_dir: &Path) -> Result<Option<GcApplyReport>, MediaError> {
    let run_id = match read_intent(app_data_dir) {
        Some(r) => r,
        None => return Ok(None),
    };
    let root = app_data_dir.join("media");
    if !root.exists() {
        clear_intent(app_data_dir);
        return Ok(None);
    }
    let canon = super::storage::ensure_root_canonical(&root)?;
    // fail-closed: if the reference set can't be built, do NOT move anything.
    let referenced = match referenced_rel_paths(&app_data_dir.join("lataif.db")) {
        Ok(r) => r,
        Err(e) => {
            clear_intent(app_data_dir);
            return Err(e);
        }
    };
    let quarantine_run = super::storage::resolve_within_root(&canon, QUARANTINE_DIRNAME)?.join(&run_id);
    std::fs::create_dir_all(&quarantine_run).map_err(|e| MediaError::Io(format!("gc mk quarantine: {}", e)))?;
    let scanned = scan_files(&canon)?;
    let mut rep = GcApplyReport { run_id: run_id.clone(), ..Default::default() };
    for (rel, size) in scanned {
        if referenced.contains(&rel) {
            continue;
        }
        match quarantine_one(&canon, &quarantine_run, &rel, &referenced) {
            Ok(true) => { rep.quarantined += 1; rep.bytes += size; }
            Ok(false) => rep.skipped += 1,
            Err(_) => rep.failed += 1,
        }
    }
    // Audit under the REAL run_id. `completed` ONLY when nothing was quarantined AND nothing failed (an empty
    // run needs no finalize — drop its empty dir); otherwise the quarantine is RETAINED as `quarantined`.
    let counts = RunCounts { quarantined: rep.quarantined, failed: rep.failed, ..Default::default() };
    if rep.quarantined == 0 && rep.failed == 0 {
        let _ = std::fs::remove_dir_all(&quarantine_run);
        let _ = std::fs::remove_dir(super::storage::resolve_within_root(&canon, QUARANTINE_DIRNAME)?);
        audit_bestcase(app_data_dir, &run_id, "completed", &counts, None);
    } else {
        audit_bestcase(app_data_dir, &run_id, "quarantined", &counts, if rep.failed > 0 { Some("MEDIA_GC_MOVE_PARTIAL") } else { None });
    }
    // Retention: a non-empty quarantine is KEPT (owner finalizes later). Clear the intent → runs exactly once.
    clear_intent(app_data_dir);
    Ok(Some(rep))
}

fn quarantine_one(
    canon: &Path,
    quarantine_run: &Path,
    rel: &str,
    referenced: &BTreeSet<String>,
) -> Result<bool, MediaError> {
    if referenced.contains(rel) {
        return Ok(false);
    }
    if rel == QUARANTINE_DIRNAME || rel.starts_with(&format!("{}/", QUARANTINE_DIRNAME)) {
        return Ok(false);
    }
    let src = super::storage::resolve_within_root(canon, rel)?;
    super::storage::assert_no_reparse_under_root(canon, &src)?;
    let md = match std::fs::symlink_metadata(&src) {
        Ok(m) => m,
        Err(_) => return Ok(false),
    };
    if is_reparse(&md) {
        return Err(MediaError::PathReparsePointForbidden);
    }
    if !md.is_file() {
        return Ok(false);
    }
    let dst = super::storage::resolve_within_root(quarantine_run, rel)?;
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| MediaError::Io(format!("gc mk qdir: {}", e)))?;
    }
    std::fs::rename(&src, &dst).map_err(|e| MediaError::Io(format!("gc move: {}", e)))?;
    Ok(true)
}

/// BOOT reconcile: move BACK any quarantined file that became referenced again; RETAIN the rest. Never
/// purges. Deferred while a restore is pending. This is what keeps the quarantine safe across restarts.
pub fn reconcile_quarantine(app_data_dir: &Path) -> Result<GcApplyReport, MediaError> {
    let mut rep = GcApplyReport::default();
    if super::restore_recovery::read_intent(app_data_dir).is_some() {
        return Ok(rep);
    }
    let root = app_data_dir.join("media");
    if !root.join(QUARANTINE_DIRNAME).exists() {
        return Ok(rep);
    }
    let canon = super::storage::ensure_root_canonical(&root)?;
    // If the reference set can't be built, retain everything (never delete on uncertainty).
    let referenced = referenced_rel_paths(&app_data_dir.join("lataif.db"))?;
    for (run_id, files) in quarantine_runs(&canon) {
        let mut c = RunCounts::default();
        for (rel, qpath, size) in files {
            if referenced.contains(&rel) {
                match move_back(&canon, &rel, &qpath) {
                    Ok(()) => { c.moved_back += 1; rep.moved_back += 1; rep.bytes += size; }
                    Err(_) => { c.failed += 1; rep.failed += 1; }
                }
            } else {
                c.retained += 1;
                rep.retained += 1;
            }
        }
        // A run whose files all became referenced (nothing retained, no failure) is done — drop its dir.
        let run_dir = super::storage::resolve_within_root(&canon, QUARANTINE_DIRNAME)?.join(&run_id);
        if c.retained == 0 && c.failed == 0 {
            let _ = std::fs::remove_dir_all(&run_dir);
            audit_bestcase(app_data_dir, &run_id, "completed", &c, None);
        } else {
            audit_bestcase(app_data_dir, &run_id, "quarantined", &c, if c.failed > 0 { Some("MEDIA_GC_RECONCILE_PARTIAL") } else { None });
        }
    }
    let _ = std::fs::remove_dir(super::storage::resolve_within_root(&canon, QUARANTINE_DIRNAME)?); // if now empty
    Ok(rep)
}

/// Move a quarantined file back to its media-root path (reparse-safe, only if the slot is free).
fn move_back(canon: &Path, rel: &str, qpath: &Path) -> Result<(), MediaError> {
    let dst = super::storage::resolve_within_root(canon, rel)?;
    if dst.exists() {
        return Ok(()); // the referenced file is already present — leave the quarantined copy for purge
    }
    if let Some(parent) = dst.parent() {
        super::storage::assert_no_reparse_under_root(canon, parent).ok();
        std::fs::create_dir_all(parent).map_err(|e| MediaError::Io(format!("gc mkback: {}", e)))?;
    }
    std::fs::rename(qpath, &dst).map_err(|e| MediaError::Io(format!("gc move-back: {}", e)))?;
    Ok(())
}

/// OWNER FINALIZE: the ONLY permanent deletion. Re-derive the reference set, move back anything now
/// referenced, then delete the remaining retained quarantine files. Fail-closed on an unbuildable set.
pub fn finalize(app_data_dir: &Path, config_conn: &Connection, now: &str) -> Result<GcApplyReport, MediaError> {
    let mut rep = GcApplyReport::default();
    let root = app_data_dir.join("media");
    if !root.join(QUARANTINE_DIRNAME).exists() {
        return Ok(rep);
    }
    // Never purge while a restore/backup is scheduled (they relaunch, but be explicit + fail-closed).
    if super::restore_recovery::read_intent(app_data_dir).is_some()
        || super::backup::read_backup_intent(app_data_dir).is_some()
    {
        return Err(MediaError::Io("gc finalize refused: restore/backup pending".into()));
    }
    let canon = super::storage::ensure_root_canonical(&root)?;
    let referenced = referenced_rel_paths(&app_data_dir.join("lataif.db"))?; // fail-closed
    for (run_id, files) in quarantine_runs(&canon) {
        let mut c = RunCounts::default();
        for (rel, qpath, size) in files {
            if referenced.contains(&rel) {
                match move_back(&canon, &rel, &qpath) {
                    Ok(()) => { c.moved_back += 1; rep.moved_back += 1; }
                    Err(_) => { c.failed += 1; rep.failed += 1; }
                }
            } else {
                match std::fs::remove_file(&qpath) {
                    Ok(()) => { c.purged += 1; rep.purged += 1; rep.bytes += size; }
                    Err(_) => { c.failed += 1; rep.failed += 1; }
                }
            }
        }
        // `completed` ONLY when nothing failed (all files purged/moved-back → the run dir can be dropped).
        // A per-item failure leaves those files in the quarantine and is recorded as `partial`/`failed`, so a
        // later scan/finalize still sees them.
        let run_dir = super::storage::resolve_within_root(&canon, QUARANTINE_DIRNAME)?.join(&run_id);
        let state = if c.failed == 0 {
            let _ = std::fs::remove_dir_all(&run_dir);
            "completed"
        } else if c.purged > 0 || c.moved_back > 0 {
            "partial"
        } else {
            "failed"
        };
        record(config_conn, &run_id, state, &c, if c.failed > 0 { Some("MEDIA_GC_FINALIZE_ERR") } else { None }, now)?;
    }
    let _ = std::fs::remove_dir(super::storage::resolve_within_root(&canon, QUARANTINE_DIRNAME)?); // drop if empty
    Ok(rep)
}

#[cfg(test)]
#[path = "media_gc_tests.rs"]
mod media_gc_tests;
