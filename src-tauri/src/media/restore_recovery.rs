//! MEDIA-04B2A12-R3 — PRODUCTION boot recovery for an interrupted atomic restore.
//!
//! Compiled into every build (unlike the test/e2e restore ACTION) and run at startup BEFORE any DB or
//! media file is opened. It reconciles a restore journal left by a crash to a NON-mixed whole state:
//!   • a pre-commit journal (`aside-begin` / `swap-begin`) → roll the live tree back to the EXACT prior
//!     state (the moved-aside originals),
//!   • the durable commit (`done`) → keep the new state and FINISH what follows the commit (RESTORE-SAFETY:
//!     verified fill-in, then the set-aside prior state is ARCHIVED — never deleted),
//!   • no journal → nothing to undo,
//!   • ANY other/corrupt journal value → fail closed (`Err`): the caller must NOT open its DBs.
//! The rollback enumerates the rollback dir, so it needs no manifest. Never logs bytes/content paths.
//!
//! RESTORE-SAFETY — the set-aside prior state is the owner's data. It is removed only when it is EMPTY;
//! a rename that fails keeps it (and the journal) so the next boot can try again, instead of losing it.

use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

use super::MediaError;

pub const STAGING: &str = ".restore-staging";
pub const ROLLBACK: &str = ".restore-rollback";
pub const JOURNAL: &str = ".restore-journal";
// MEDIA-04B2A12-U1-R1 — the durable pending-restore INTENT. A scheduled restore writes this (owner-gated,
// NO mutation) and relaunches; the boot path applies the restore while the DBs are closed and clears the
// intent only after a durable success → exactly-once.
pub const INTENT: &str = ".restore-intent";
const INTENT_TMP: &str = ".restore-intent.tmp";

/// Durably write the pending-restore intent (opaque snapshotId) via temp → fsync → atomic rename, so a
/// crash never leaves a torn intent that could trigger an unintended restore.
pub fn write_intent(app_data_dir: &Path, snapshot_id: &str) -> Result<(), MediaError> {
    let tmp = app_data_dir.join(INTENT_TMP);
    {
        let mut f = File::create(&tmp).map_err(|e| MediaError::Io(format!("intent open: {}", e)))?;
        f.write_all(snapshot_id.as_bytes()).map_err(|e| MediaError::Io(format!("intent write: {}", e)))?;
        f.sync_all().map_err(|e| MediaError::Io(format!("intent fsync: {}", e)))?;
    }
    fs::rename(&tmp, app_data_dir.join(INTENT)).map_err(|e| MediaError::Io(format!("intent rename: {}", e)))
}

/// Read the pending intent (opaque snapshotId), or None when absent/empty.
pub fn read_intent(app_data_dir: &Path) -> Option<String> {
    fs::read_to_string(app_data_dir.join(INTENT))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Durably consume the intent (no-op if already gone).
pub fn clear_intent(app_data_dir: &Path) -> Result<(), MediaError> {
    let p = app_data_dir.join(INTENT);
    if p.exists() {
        fs::remove_file(&p).map_err(|e| MediaError::Io(format!("intent clear: {}", e)))?;
    }
    Ok(())
}

/// Durable, write-ahead journal update: the state is fsync'd before the action it guards runs.
pub fn journal_write(path: &Path, state: &str) -> Result<(), MediaError> {
    let mut f = File::create(path).map_err(|e| MediaError::Io(format!("journal open: {}", e)))?;
    f.write_all(state.as_bytes()).map_err(|e| MediaError::Io(format!("journal write: {}", e)))?;
    f.sync_all().map_err(|e| MediaError::Io(format!("journal fsync: {}", e)))?;
    Ok(())
}

/// Undo a (partial) swap: move everything set aside back into live, discarding any partial restore that
/// already landed (that is only a copy of the backup). Enumerates the rollback dir.
///
/// RESTORE-SAFETY — `Err` when ANY original could not be moved back: then the rollback dir is KEPT with
/// whatever is still in it (never `remove_dir_all`), so a later attempt can finish — an original is never
/// deleted. Idempotent: what is already back is simply no longer in the rollback dir.
pub fn rollback_to_prior(live: &Path, rollback: &Path) -> Result<(), MediaError> {
    if !rollback.exists() {
        return Ok(());
    }
    let entries = fs::read_dir(rollback).map_err(|e| MediaError::Io(format!("rollback read: {}", e)))?;
    let mut failed = false;
    for e in entries {
        let Ok(e) = e else { failed = true; continue };
        let dst = live.join(e.file_name());
        if fs::symlink_metadata(&dst).is_ok() {
            let cleared = if dst.is_dir() { fs::remove_dir_all(&dst) } else { fs::remove_file(&dst) };
            if cleared.is_err() {
                failed = true;
                continue;
            }
        }
        if fs::rename(e.path(), &dst).is_err() {
            failed = true;
        }
    }
    if failed {
        return Err(MediaError::Io("rollback incomplete — set-aside state kept".into()));
    }
    // Empty now: `remove_dir` (not `_all`) can never take an original with it.
    let _ = fs::remove_dir(rollback);
    Ok(())
}

/// RESTORE-SAFETY — is the live installation missing something the set-aside state holds? Every database and
/// the media folder in the set-aside state must exist in live (a `-wal`/`-shm` sidecar may legitimately be
/// absent), and EVERY such live database — the main one AND the server one — must pass `PRAGMA quick_check`.
/// Returns the reason code, or `None` when live is complete.
fn live_incomplete_against(live: &Path, rollback: &Path) -> Option<&'static str> {
    let Ok(entries) = fs::read_dir(rollback) else { return Some("ROLLBACK_UNREADABLE") };
    let mut databases = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.ends_with("-wal") || name.ends_with("-shm") || name.ends_with("-journal") || name == "archive.json" {
            continue;
        }
        let here = live.join(&name);
        let is_dir = e.path().is_dir();
        let present = if is_dir { here.is_dir() } else { fs::metadata(&here).map(|m| m.is_file() && m.len() > 0).unwrap_or(false) };
        if !present {
            return Some("LIVE_INCOMPLETE");
        }
        if !is_dir {
            databases.push(here);
        }
    }
    for db in &databases {
        if !live_db_passes_quick_check(db) {
            return Some("LIVE_DB_DAMAGED");
        }
    }
    None
}

static CHECK_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// `PRAGMA quick_check` on a COPY of the live database together with its committed sidecars (`-wal`, a
/// rollback `-journal`), in a private temp folder: the check sees exactly what the app would open, and the
/// live files are never opened, replayed or checkpointed. Any failure counts as damaged (fail-closed).
fn live_db_passes_quick_check(db: &Path) -> bool {
    let Some(name) = db.file_name().map(|n| n.to_string_lossy().to_string()) else { return false };
    let dir = std::env::temp_dir().join(format!(
        "lataif-restore-check-{}-{}",
        std::process::id(),
        CHECK_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&dir);
    if fs::create_dir_all(&dir).is_err() {
        return false;
    }
    let ok = (|| -> Option<bool> {
        fs::copy(db, dir.join(&name)).ok()?;
        for suffix in ["-wal", "-journal"] {
            let side = db.with_file_name(format!("{name}{suffix}"));
            if side.exists() {
                fs::copy(&side, dir.join(format!("{name}{suffix}"))).ok()?;
            }
        }
        let c = rusqlite::Connection::open(dir.join(&name)).ok()?;
        let r: String = c.query_row("PRAGMA quick_check", [], |r| r.get(0)).ok()?;
        Some(r == "ok")
    })()
    .unwrap_or(false);
    let _ = fs::remove_dir_all(&dir);
    ok
}

/// Boot recovery. Returns `Ok` once the tree is a consistent whole (old or committed-new); returns `Err`
/// (fail-closed) on an unrecoverable journal or an incomplete rollback, so the caller aborts startup
/// without touching the DBs.
pub fn recover(app_data_dir: &Path) -> Result<(), MediaError> {
    use super::restore_archive as ra;
    let live = app_data_dir;
    let journal = live.join(JOURNAL);
    let rollback = live.join(ROLLBACK);
    let staging = live.join(STAGING);
    let state = match fs::read_to_string(&journal) {
        Ok(s) => s,
        Err(_) => {
            // No restore in flight. A context without a journal is a restore that stopped before it touched
            // anything (between writing the context and the first journal entry) — nothing to undo.
            if live.join(ra::CONTEXT_FILE).exists() {
                let ctx = ra::read_context(live);
                ra::note(live, "recovered_not_started", ctx.as_ref(), None, None, None);
                ra::clear_context(live);
                let _ = fs::remove_dir_all(&staging);
            }
            // A set-aside state WITHOUT a journal (left by an older version or by hand) is archived untouched —
            // but ONLY when the live installation is complete. If live lacks anything the set-aside state holds
            // (a database, the media folder) or its main database does not pass a quick check, the set-aside
            // state may be the only complete one: then nothing moves and startup stops (fail-closed).
            if fs::read_dir(&rollback).map(|mut r| r.next().is_some()).unwrap_or(false) {
                let ctx = ra::RestoreContext::unknown(live);
                if let Some(missing) = live_incomplete_against(live, &rollback) {
                    ra::note(live, "orphan_rollback_kept", Some(&ctx), None, Some(missing), None);
                    return Err(MediaError::Io("set-aside state kept: the live installation is incomplete".into()));
                }
                match ra::finish_after_commit(live, &ctx, &|_| Ok(())) {
                    Ok(rep) => ra::note(live, "orphan_rollback_archived", Some(&ctx), None, None, serde_json::to_value(&rep.archive).ok()),
                    Err(e) => ra::note(live, "orphan_rollback_kept", Some(&ctx), None, Some(e.code()), None),
                }
            }
            return Ok(());
        }
    };
    let ctx = ra::read_context(live);
    match state.trim() {
        "aside-begin" | "swap-begin" => {
            // pre-commit → OLD state (intent kept → the scheduled restore re-runs)
            if let Err(e) = rollback_to_prior(live, &rollback) {
                ra::note(live, "recover_failed", ctx.as_ref(), None, Some("ROLLBACK_INCOMPLETE"), None);
                return Err(e); // fail closed: journal + set-aside state stay for the next attempt
            }
            ra::note(live, "recovered_rolled_back", ctx.as_ref(), None, None, None);
        }
        "done" => {
            // Committed restore that crashed BEFORE it was finished: keep the new state, CLEAR the intent so
            // the scheduled restore never repeats (exactly-once), and finish fill-in + archive.
            let _ = fs::remove_file(live.join(INTENT));
            let ctx = ctx.unwrap_or_else(|| ra::RestoreContext::unknown(live));
            match ra::finish_after_commit(live, &ctx, &|_| Ok(())) {
                Ok(rep) => {
                    ra::note(live, "recovered_completed", Some(&ctx), None, None, serde_json::to_value(&rep).ok());
                }
                Err(e) => {
                    // The committed state is consistent; nothing is lost (the set-aside state stays). Start
                    // normally and try again at the next boot — the journal stays as the marker.
                    ra::note(live, "finish_deferred", Some(&ctx), None, Some(e.code()), None);
                    let _ = fs::remove_dir_all(&staging);
                    return Ok(());
                }
            }
        }
        _ => {
            ra::note(live, "recover_failed", ctx.as_ref(), None, Some("UNRECOVERABLE_JOURNAL"), None);
            return Err(MediaError::Io("unrecoverable restore journal state".into())); // fail closed
        }
    }
    let _ = fs::remove_dir_all(&staging);
    ra::clear_context(live);
    let _ = fs::remove_file(&journal);
    Ok(())
}
