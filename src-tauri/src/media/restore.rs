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

use super::backup::{collect_selection_from_db, BackupManifest};
use super::restore_recovery::{journal_write, rollback_to_prior, JOURNAL, ROLLBACK, STAGING};
use super::storage::{read_verified_media, sha256_hex};
use super::MediaError;

// MEDIA-04B2A12-R3 — boot recovery lives in the always-compiled `restore_recovery`; re-export it so the
// e2e restore smoke can reach it via this module too.
pub use super::restore_recovery::recover;

pub const MAX_RESTORE_FORMAT_VERSION: u32 = super::backup::BACKUP_FORMAT_VERSION;
const CRASH: &str = "SIMULATED_CRASH";

/// Test-only crash points, taken right after a journal write or a rename group.
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

/// Test-only: run the REAL swap but simulate a process crash right after `crash_at` — leaving the true
/// on-disk state (journal + partial renames) for `recover()`, with NO in-process rollback/cleanup.
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
            move_path(&live.join(name), &rollback.join(name))?;
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

#[cfg(test)]
#[path = "restore_tests.rs"]
mod restore_tests;
