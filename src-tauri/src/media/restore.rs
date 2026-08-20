//! MEDIA-04B2A12-R1/R2 — REAL atomic DB+media restore from a `complete` snapshot, crash-safe.
//!
//! Contract:
//!   • restore ONLY from a `complete` snapshot; a FULL pre-check runs BEFORE any live mutation (manifest
//!     version, canonical/safe paths, no symlink/reparse/traversal, every DB+media file present with
//!     matching size+SHA-256, and NO unexpected file in the backup dir),
//!   • the caller has stopped app/server writes and closed the DBs (process quiesced),
//!   • the validated backup is COPIED into a local staging dir (same volume as live → a later rename is
//!     atomic even when the backup is on another volume) and the STAGED bytes are re-hashed against the
//!     manifest — closing any read-time-of-check/time-of-use gap BEFORE live is touched,
//!   • the swap moves the live DBs + the whole media root ASIDE (rollback point) then moves the staged
//!     restore in — DB and media as ONE unit; the app is stopped, so no reader observes a mixed state,
//!   • a WRITE-AHEAD, fsync'd journal records the phase BEFORE each rename group; the commit point is the
//!     durable `done` written only AFTER a full swap + integrity verify. On ANY in-process error the live
//!     tree is rolled back to the EXACT prior state; a crash at ANY step is reconciled by `recover()` to
//!     the OLD state (never a mixed old/new stand) — the backup SOURCE is never modified.
//! Never logs bytes/content paths.

use std::collections::BTreeSet;
use std::fs;

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::backup::{collect_selection_from_db, BackupManifest};
use super::restore_recovery::{journal_write, rollback_to_prior, JOURNAL, ROLLBACK, STAGING};
use super::storage::{read_verified_media, sha256_hex};
use super::MediaError;

// MEDIA-04B2A12-R3 — boot recovery lives in the always-compiled `restore_recovery`; re-export it so the
// e2e restore smoke can reach it via this module too.
pub use super::restore_recovery::recover;

pub const MAX_RESTORE_FORMAT_VERSION: u32 = super::backup::BACKUP_FORMAT_VERSION;
const CRASH: &str = "SIMULATED_CRASH";

/// Test-only crash points, taken right after a journal write or a rename group. Never exposed in a
/// production build (constructed only by the `cfg(test, e2e)` crash-injection entry below).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashAt {
    AsideJournalled,
    MovedAside,
    SwapJournalled,
    SwappedIn,
}

fn is_unsafe_rel(p: &str) -> bool {
    if p.is_empty() || p.contains('\0') || p.contains('\\') || p.starts_with('/') {
        return true;
    }
    if p.len() >= 2 && p.as_bytes()[1] == b':' {
        return true; // drive-letter absolute
    }
    p.split('/').any(|s| s.is_empty() || s == "." || s == "..")
}
fn is_symlink(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}
fn hash_file(p: &Path) -> Result<(u64, String), MediaError> {
    let bytes = fs::read(p).map_err(|e| MediaError::Io(format!("read: {}", e)))?;
    Ok((bytes.len() as u64, sha256_hex(&bytes)))
}
fn io<E: std::fmt::Display>(ctx: &'static str) -> impl Fn(E) -> MediaError {
    move |e| MediaError::Io(format!("{}: {}", ctx, e))
}

/// FULL pre-check of a backup dir. Returns the parsed manifest. Performs NO mutation.
pub fn validate_snapshot(backup_dir: &Path) -> Result<BackupManifest, MediaError> {
    let raw = fs::read(backup_dir.join("manifest.json")).map_err(io("manifest read"))?;
    let manifest: BackupManifest = serde_json::from_slice(&raw).map_err(io("manifest parse"))?;
    if manifest.backup_format_version > MAX_RESTORE_FORMAT_VERSION {
        return Err(MediaError::RestoreUnknownVersion);
    }
    if manifest.status != "complete" || manifest.file_count != manifest.files.len() {
        return Err(MediaError::RestoreIncompleteBackup);
    }
    let mut expected: BTreeSet<String> = BTreeSet::new();
    expected.insert("manifest.json".into());
    let mut check = |rel: &str, size: u64, sha: &str| -> Result<(), MediaError> {
        if is_unsafe_rel(rel) {
            return Err(MediaError::PathOutsideRoot);
        }
        let abs = backup_dir.join(rel);
        if is_symlink(&abs) {
            return Err(MediaError::PathReparsePointForbidden);
        }
        if !abs.exists() {
            return Err(MediaError::FileMissing);
        }
        let (s, h) = hash_file(&abs)?;
        if s != size || h != sha {
            return Err(MediaError::FileHashMismatch);
        }
        expected.insert(rel.to_string());
        Ok(())
    };
    check(&manifest.db.file_name, manifest.db.byte_size, &manifest.db.sha256)?;
    for d in &manifest.additional_db_files {
        check(&d.file_name, d.byte_size, &d.sha256)?;
    }
    for f in &manifest.files {
        check(&f.rel_path, f.byte_size, &f.hash)?;
    }
    let mut stack = vec![backup_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in fs::read_dir(&dir).map_err(io("readdir"))? {
            let p = e.map_err(io("dirent"))?.path();
            if is_symlink(&p) {
                return Err(MediaError::PathReparsePointForbidden);
            }
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            let rel = p.strip_prefix(backup_dir).unwrap().to_string_lossy().replace('\\', "/");
            if !expected.contains(&rel) {
                return Err(MediaError::RestoreUnexpectedFile);
            }
        }
    }
    Ok(manifest)
}

fn copy_into(src: &Path, dst: &Path) -> Result<(), MediaError> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(io("mkdir copy"))?;
    }
    fs::copy(src, dst).map_err(io("copy"))?;
    Ok(())
}
/// Move `from`→`to` if `from` exists (a first-ever restore has no live media dir → no-op).
fn move_path(from: &Path, to: &Path) -> Result<(), MediaError> {
    if !from.exists() {
        return Ok(());
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(io("mkdir move"))?;
    }
    fs::rename(from, to).map_err(io("rename"))
}

/// Re-hash EVERY staged copy against the manifest — the bytes that will actually be swapped in must match
/// (closes the backup read TOCTOU; live is still untouched here).
fn verify_staging(staging: &Path, manifest: &BackupManifest) -> Result<(), MediaError> {
    let check = |rel: &str, size: u64, sha: &str| -> Result<(), MediaError> {
        let abs = staging.join(rel);
        if is_symlink(&abs) {
            return Err(MediaError::PathReparsePointForbidden);
        }
        let (s, h) = hash_file(&abs)?;
        if s != size || h != sha {
            return Err(MediaError::FileHashMismatch);
        }
        Ok(())
    };
    check(&manifest.db.file_name, manifest.db.byte_size, &manifest.db.sha256)?;
    for d in &manifest.additional_db_files {
        check(&d.file_name, d.byte_size, &d.sha256)?;
    }
    for f in &manifest.files {
        check(&format!("media/{}", f.rel_path), f.byte_size, &f.hash)?;
    }
    Ok(())
}

pub struct RestoreInput<'a> {
    pub backup_dir: &'a Path,
    pub app_data_dir: &'a Path,
}

/// Atomically restore DB+media as a unit (see module contract). `inject_swap_failure` (tests) forces an
/// in-process error mid-swap to prove the rollback path.
pub fn restore(input: &RestoreInput, inject_swap_failure: bool) -> Result<BackupManifest, MediaError> {
    restore_impl(input, inject_swap_failure, None)
}

/// Test/e2e-only: run the REAL swap but simulate a process crash right after `crash_at` — leaving the
/// true on-disk state (journal + partial renames) for `recover()`, with NO in-process rollback/cleanup.
/// Never compiled into a production build → the crash-injection surface is never exposed.
#[cfg(any(test, feature = "e2e"))]
pub fn restore_crashing(input: &RestoreInput, crash_at: CrashAt) -> Result<BackupManifest, MediaError> {
    restore_impl(input, false, Some(crash_at))
}

fn restore_impl(
    input: &RestoreInput,
    inject_swap_failure: bool,
    crash_at: Option<CrashAt>,
) -> Result<BackupManifest, MediaError> {
    let manifest = validate_snapshot(input.backup_dir)?; // live untouched on any pre-check failure
    let live = input.app_data_dir;
    let staging = live.join(STAGING);
    let rollback = live.join(ROLLBACK);
    let journal_path = live.join(JOURNAL);
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_dir_all(&rollback);
    let _ = fs::remove_file(&journal_path);
    fs::create_dir_all(&staging).map_err(io("mkstaging"))?;
    fs::create_dir_all(&rollback).map_err(io("mkrollback"))?;

    let mut db_names: Vec<String> = vec![manifest.db.file_name.clone()];
    for d in &manifest.additional_db_files {
        db_names.push(d.file_name.clone());
    }

    // ── 1. stage the validated backup locally, then RE-VERIFY the staged bytes (live untouched) ──
    let prep = || -> Result<(), MediaError> {
        for name in &db_names {
            copy_into(&input.backup_dir.join(name), &staging.join(name))?;
        }
        for f in &manifest.files {
            copy_into(&input.backup_dir.join(&f.rel_path), &staging.join("media").join(&f.rel_path))?;
        }
        verify_staging(&staging, &manifest)
    };
    if let Err(e) = prep() {
        let _ = fs::remove_dir_all(&staging);
        let _ = fs::remove_dir_all(&rollback);
        return Err(e); // live never touched
    }

    // ── 2. swap (write-ahead journal before each rename group). Any error/crash → live rolls back. ──
    let crash = |p: CrashAt| -> Result<(), MediaError> {
        if crash_at == Some(p) {
            Err(MediaError::Io(CRASH.into()))
        } else {
            Ok(())
        }
    };
    let outcome = (|| -> Result<(), MediaError> {
        journal_write(&journal_path, "aside-begin")?; // WRITE-AHEAD: declares the aside group before it runs
        crash(CrashAt::AsideJournalled)?;
        for name in &db_names {
            // Move the DB AND its WAL/SHM sidecars aside as one unit — a stale `-wal`/`-shm` left next to
            // a swapped-in DB would be replayed over it on next open (silent corruption). The staged
            // snapshot carries a checkpointed self-contained DB (no sidecars) so the restored DB is clean;
            // rollback restores the old DB together with its sidecars.
            for suffix in ["", "-wal", "-shm"] {
                let f = format!("{}{}", name, suffix);
                move_path(&live.join(&f), &rollback.join(&f))?;
            }
        }
        move_path(&live.join("media"), &rollback.join("media"))?;
        crash(CrashAt::MovedAside)?;
        if inject_swap_failure {
            return Err(MediaError::Io("injected swap failure".into()));
        }
        journal_write(&journal_path, "swap-begin")?; // WRITE-AHEAD: declares the swap-in group
        crash(CrashAt::SwapJournalled)?;
        for name in &db_names {
            move_path(&staging.join(name), &live.join(name))?;
        }
        move_path(&staging.join("media"), &live.join("media"))?;
        crash(CrashAt::SwappedIn)?;
        verify_restored(live, &manifest).map(|_| ()) // integrity BEFORE the durable commit
    })();

    match outcome {
        Ok(()) => {
            journal_write(&journal_path, "done")?; // COMMIT POINT (durable)
            let _ = fs::remove_dir_all(&staging);
            let _ = fs::remove_dir_all(&rollback);
            let _ = fs::remove_file(&journal_path);
            Ok(manifest)
        }
        Err(MediaError::Io(ref s)) if s == CRASH => {
            // simulated crash: leave the real on-disk state (journal + partial renames) for recover()
            Err(MediaError::Io(CRASH.into()))
        }
        Err(e) => {
            rollback_to_prior(live, &rollback); // in-process error → exact prior state
            let _ = fs::remove_dir_all(&staging);
            let _ = fs::remove_file(&journal_path);
            Err(e)
        }
    }
}

/// Open the restored frontend DB and re-resolve EVERY gallery reference via the safe verified read —
/// proves products/master/variants are visible and their media files are present + hash-correct.
pub fn verify_restored(app_data_dir: &Path, manifest: &BackupManifest) -> Result<usize, MediaError> {
    let front = app_data_dir.join(&manifest.db.file_name);
    let (_, h) = hash_file(&front)?;
    if h != manifest.db.sha256 {
        return Err(MediaError::FileHashMismatch);
    }
    let media_root = app_data_dir.join("media");
    let conn = rusqlite::Connection::open(&front).map_err(io("open restored db"))?;
    let selection = collect_selection_from_db(&conn)?;
    for s in &selection {
        read_verified_media(&media_root, &s.scope, &s.hash, &s.extension)?;
    }
    Ok(selection.len())
}

// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04B2A12-U1 — production safe listing + id-only restore (the surface the Tauri commands call).
// The renderer NEVER supplies a filesystem path: it gets opaque ids from `list_snapshots` and passes an id
// back to `restore_by_id`, which re-resolves it against the ONE canonical backups root — the value
// `backup_location::resolve_root` returns, i.e. the owner-configured location when there is one and
// `<data_root>/backups/` otherwise. There is no second, hard-wired `<app_data_dir>/backups/` path:
// listing and restoring must read the SAME root the snapshots were written to.
// ════════════════════════════════════════════════════════════════════════════

/// A snapshotId must be a single safe path segment — never a traversal, absolute path, or nested path.
/// Test-only view of the segment rule, so the id generator can prove its output is resolvable.
#[cfg(test)]
pub fn is_unsafe_segment_for_test(id: &str) -> bool {
    is_unsafe_segment(id)
}

fn is_unsafe_segment(id: &str) -> bool {
    id.is_empty()
        || id == "."
        || id == ".."
        || id.contains('/')
        || id.contains('\\')
        || id.contains('\0')
        || (id.len() >= 2 && id.as_bytes()[1] == b':') // drive-letter absolute
}

/// Sanitised summary the UI can render. Carries NO absolute path — only the opaque id + date/version +
/// aggregate sizes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotSummary {
    /// Opaque id = the backup dir's single-segment name. Never a filesystem path.
    pub snapshot_id: String,
    pub created_at: String,
    pub app_version: String,
    pub db_size_bytes: u64,
    pub media_size_bytes: u64,
    pub media_file_count: usize,
}

/// Re-resolve an opaque snapshotId to its canonical backup dir under `<app_data_dir>/backups/`. Rejects any
/// id that is not a single safe segment, is a symlink, or (after canonicalisation) does not sit DIRECTLY
/// under the backups root. Never accepts a free/absolute path.
pub fn resolve_snapshot_id(app_data_dir: &Path, snapshot_id: &str) -> Result<PathBuf, MediaError> {
    if is_unsafe_segment(snapshot_id) {
        return Err(MediaError::PathOutsideRoot);
    }
    let root = super::backup_location::resolve_root(app_data_dir);
    let dir = root.join(snapshot_id);
    if is_symlink(&dir) {
        return Err(MediaError::PathReparsePointForbidden);
    }
    let root_c = fs::canonicalize(&root).map_err(io("backups root"))?;
    let dir_c = fs::canonicalize(&dir).map_err(io("snapshot dir"))?;
    if dir_c.parent() != Some(root_c.as_path()) {
        return Err(MediaError::PathOutsideRoot); // escaped the canonical backups root
    }
    Ok(dir_c)
}

/// List ONLY safe, `complete`, fully pre-checked snapshots under `<app_data_dir>/backups/`. Any dir that
/// fails the full pre-check (incomplete, foreign schema, tampered, symlink, unexpected file, unsafe name)
/// is silently skipped — never surfaced. Returns opaque ids + sanitised totals only; no path leaves Rust.
pub fn list_snapshots(app_data_dir: &Path) -> Result<Vec<SnapshotSummary>, MediaError> {
    let root = super::backup_location::resolve_root(app_data_dir);
    let mut out: Vec<SnapshotSummary> = Vec::new();
    let entries = match fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return Ok(out), // no backups dir yet → empty list
    };
    for e in entries {
        let path = match e {
            Ok(x) => x.path(),
            Err(_) => continue,
        };
        if is_symlink(&path) || !path.is_dir() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) if !is_unsafe_segment(n) => n.to_string(),
            _ => continue,
        };
        // FULL pre-check — only a valid, complete snapshot is ever listed.
        let manifest = match validate_snapshot(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let db_size_bytes = manifest.db.byte_size
            + manifest.additional_db_files.iter().map(|d| d.byte_size).sum::<u64>();
        let media_size_bytes = manifest.files.iter().map(|f| f.byte_size).sum::<u64>();
        out.push(SnapshotSummary {
            snapshot_id: name,
            created_at: manifest.created_at,
            app_version: manifest.app_version,
            db_size_bytes,
            media_size_bytes,
            media_file_count: manifest.files.len(),
        });
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at)); // newest first
    Ok(out)
}

/// Restore by opaque id: re-resolve to the canonical root (rejecting traversal/foreign ids), then run the
/// full atomic restore (which itself re-validates before touching anything). No crash injection.
pub fn restore_by_id(app_data_dir: &Path, snapshot_id: &str) -> Result<BackupManifest, MediaError> {
    let backup_dir = resolve_snapshot_id(app_data_dir, snapshot_id)?;
    restore(&RestoreInput { backup_dir: &backup_dir, app_data_dir }, false)
}

// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04B2A12-U1-R1 — scheduled boot-time restore. A live restore never mutates the running process:
// the owner SCHEDULES a durable intent (validated, no mutation), the app relaunches, and the boot path
// applies the restore while every DB is closed, clearing the intent only on durable success (exactly-once).
// ════════════════════════════════════════════════════════════════════════════

/// Owner-gated SCHEDULE (called by the command after verifying the owner): re-resolve the opaque id to the
/// canonical backups root, run the FULL pre-check, then durably record the pending intent. Performs NO
/// DB/media mutation — a wrong/foreign/incomplete id fails here with nothing written.
pub fn schedule_restore(app_data_dir: &Path, snapshot_id: &str) -> Result<(), MediaError> {
    let backup_dir = resolve_snapshot_id(app_data_dir, snapshot_id)?;
    validate_snapshot(&backup_dir)?; // full pre-check BEFORE any intent is written
    super::restore_recovery::write_intent(app_data_dir, snapshot_id)
}

/// Boot-time application of a pending scheduled restore. MUST run before any DB/media file is opened (after
/// `recover()` has reconciled any interrupted swap). If an intent exists: re-resolve + full re-validate,
/// apply the atomic restore (own crash-safe journal), then durably clear the intent. Returns the applied
/// snapshotId, or None when there is nothing to do. Fail-closed: on any error the intent is kept and the
/// error propagates so the caller aborts startup without opening the DBs.
///
/// Exactly-once: the intent is the sole idempotency token. A crash mid-swap is rolled back by `recover()`
/// and re-applied here (the intent survived); a crash after commit but before the intent is cleared is
/// consumed by `recover()`'s `done` branch (or, in the sub-millisecond window after the journal was
/// cleaned, re-applies the IDENTICAL snapshot idempotently and then clears the intent). Once the intent is
/// durably gone, no further restore ever runs.
pub fn execute_pending_restore(app_data_dir: &Path) -> Result<Option<String>, MediaError> {
    let id = match super::restore_recovery::read_intent(app_data_dir) {
        Some(s) => s,
        None => return Ok(None),
    };
    let backup_dir = resolve_snapshot_id(app_data_dir, &id)?; // re-resolve under the canonical root
    validate_snapshot(&backup_dir)?; // re-validate the on-disk snapshot (defence-in-depth)
    restore(&RestoreInput { backup_dir: &backup_dir, app_data_dir }, false)?; // atomic, DBs closed at boot
    super::restore_recovery::clear_intent(app_data_dir)?; // durable success → consume the intent
    Ok(Some(id))
}

#[cfg(test)]
#[path = "restore_tests.rs"]
mod restore_tests;
