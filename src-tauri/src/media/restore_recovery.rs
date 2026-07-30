//! MEDIA-04B2A12-R3 — PRODUCTION boot recovery for an interrupted atomic restore.
//!
//! Compiled into every build (unlike the test/e2e restore ACTION) and run at startup BEFORE any DB or
//! media file is opened. It reconciles a restore journal left by a crash to a NON-mixed whole state:
//!   • a pre-commit journal (`aside-begin` / `swap-begin`) → roll the live tree back to the EXACT prior
//!     state (the moved-aside originals),
//!   • the durable commit (`done`) or no journal → nothing to undo, just clean up the temp dirs,
//!   • ANY other/corrupt journal value → fail closed (`Err`): the caller must NOT open its DBs.
//! The rollback enumerates the rollback dir, so it needs no manifest. Never logs bytes/content paths.

use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

use super::MediaError;

pub const STAGING: &str = ".restore-staging";
pub const ROLLBACK: &str = ".restore-rollback";
pub const JOURNAL: &str = ".restore-journal";

/// Durable, write-ahead journal update: the state is fsync'd before the action it guards runs.
pub fn journal_write(path: &Path, state: &str) -> Result<(), MediaError> {
    let mut f = File::create(path).map_err(|e| MediaError::Io(format!("journal open: {}", e)))?;
    f.write_all(state.as_bytes()).map_err(|e| MediaError::Io(format!("journal write: {}", e)))?;
    f.sync_all().map_err(|e| MediaError::Io(format!("journal fsync: {}", e)))?;
    Ok(())
}

/// Undo a (partial) swap: move everything set aside back into live, discarding any partial restore that
/// already landed. Enumerates the rollback dir.
pub fn rollback_to_prior(live: &Path, rollback: &Path) {
    if let Ok(entries) = fs::read_dir(rollback) {
        for e in entries.flatten() {
            let name = e.file_name();
            let dst = live.join(&name);
            if dst.is_dir() {
                let _ = fs::remove_dir_all(&dst);
            } else {
                let _ = fs::remove_file(&dst);
            }
            let _ = fs::rename(e.path(), &dst);
        }
    }
    let _ = fs::remove_dir_all(rollback);
}

/// Boot recovery. Returns `Ok` once the tree is a consistent whole (old or committed-new); returns `Err`
/// (fail-closed) on an unrecoverable journal so the caller aborts startup without touching the DBs.
pub fn recover(app_data_dir: &Path) -> Result<(), MediaError> {
    let live = app_data_dir;
    let journal = live.join(JOURNAL);
    let rollback = live.join(ROLLBACK);
    let staging = live.join(STAGING);
    let state = match fs::read_to_string(&journal) {
        Ok(s) => s,
        Err(_) => return Ok(()), // no restore in flight
    };
    match state.trim() {
        "aside-begin" | "swap-begin" => rollback_to_prior(live, &rollback), // pre-commit → OLD
        "done" => {}                                                        // committed → keep
        _ => return Err(MediaError::Io("unrecoverable restore journal state".into())), // fail closed
    }
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_dir_all(&rollback);
    let _ = fs::remove_file(&journal);
    Ok(())
}
