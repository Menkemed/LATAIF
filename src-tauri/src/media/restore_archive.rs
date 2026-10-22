//! RESTORE-SAFETY — a restore never makes data disappear without a trace.
//!
//! Before this module a committed restore deleted the set-aside prior state (`.restore-rollback`): both
//! databases AND the whole previous media folder. Everything the chosen backup did not carry was gone for
//! good — photos removed from a gallery, photos of deleted items, older generations — and nothing recorded
//! that a restore had happened at all (2026-10-21: 24 generation rows without a file, cause only inferable).
//!
//! Now, after the durable commit (`done`):
//!   1. FILL-IN — every file the RESTORED database itself lists (a `media_blob_generations` row) but the
//!      backup did not carry is copied back from the set-aside media — ONLY when its identity is proven: the
//!      safe storage key from that row, the file name equal to the row's content hash, the exact byte size
//!      and the SHA-256 of the bytes. Never by name alone, never over an existing file. No gallery link is
//!      touched: the restored database alone decides what is visible.
//!   2. ARCHIVE — the set-aside prior state is RENAMED (same volume: no copy, no extra space) to
//!      `restore-archive/<archiveId>/` with an `archive.json`. Nothing deletes it automatically.
//!   3. HISTORY — every step lands in `restore-history.jsonl` in the data root, OUTSIDE the swapped set
//!      (databases + `media`), so it survives every later restore. Ids, codes and counts only — no path,
//!      no content.
//! All three are idempotent: a crash anywhere after the commit is finished by `recover()` from the durable
//! `.restore-context.json`, which names the snapshot and the archive id chosen BEFORE the swap began.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::restore_recovery::{ROLLBACK, STAGING};
use super::storage::sha256_hex;
use super::MediaError;

/// Durable archives of the state a restore replaced. Never deleted automatically.
pub const ARCHIVE_DIR: &str = "restore-archive";
/// Append-only restore history in the data root — outside the swapped set, so it survives every restore.
pub const HISTORY_FILE: &str = "restore-history.jsonl";
/// Durable facts of the restore in flight (snapshot, archive id). Transient: removed when the restore is done.
pub const CONTEXT_FILE: &str = ".restore-context.json";
const CONTEXT_TMP: &str = ".restore-context.json.tmp";
const ARCHIVE_META: &str = "archive.json";
/// The frontend database inside a data root / snapshot (the backup always names it so).
pub const FRONT_DB: &str = "lataif.db";
/// Head-room on top of the bytes a restore must write (staged copy + fill-in).
const SPACE_MARGIN_MIN: u64 = 64 * 1024 * 1024;

fn io<E: std::fmt::Display>(ctx: &'static str) -> impl Fn(E) -> MediaError {
    move |e| MediaError::Io(format!("{}: {}", ctx, e))
}

fn is_unsafe_rel(p: &str) -> bool {
    if p.is_empty() || p.contains('\0') || p.contains('\\') || p.starts_with('/') {
        return true;
    }
    if p.len() >= 2 && p.as_bytes()[1] == b':' {
        return true;
    }
    p.split('/').any(|s| s.is_empty() || s == "." || s == "..")
}
fn is_symlink(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

// ── context ───────────────────────────────────────────────────────────────────────────────────────

/// What a restore in flight must remember across a crash.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreContext {
    pub snapshot_id: String,
    pub snapshot_created_at: String,
    pub started_at: String,
    pub archive_id: String,
}

impl RestoreContext {
    /// A context for a journal left by a version that wrote none: the archive still gets a unique name.
    pub fn unknown(live: &Path) -> Self {
        RestoreContext {
            snapshot_id: "unknown".into(),
            snapshot_created_at: String::new(),
            started_at: String::new(),
            archive_id: new_archive_id(live, chrono::Utc::now()),
        }
    }
}

pub fn write_context(live: &Path, ctx: &RestoreContext) -> Result<(), MediaError> {
    let tmp = live.join(CONTEXT_TMP);
    {
        let mut f = File::create(&tmp).map_err(io("context open"))?;
        let raw = serde_json::to_vec(ctx).map_err(io("context encode"))?;
        f.write_all(&raw).map_err(io("context write"))?;
        f.sync_all().map_err(io("context fsync"))?;
    }
    fs::rename(&tmp, live.join(CONTEXT_FILE)).map_err(io("context rename"))
}

pub fn read_context(live: &Path) -> Option<RestoreContext> {
    let raw = fs::read(live.join(CONTEXT_FILE)).ok()?;
    serde_json::from_slice(&raw).ok()
}

pub fn clear_context(live: &Path) {
    let _ = fs::remove_file(live.join(CONTEXT_FILE));
    let _ = fs::remove_file(live.join(CONTEXT_TMP));
}

/// `pre-restore-<UTC>` — unique inside `restore-archive/` (a suffix resolves a same-second collision).
pub fn new_archive_id(live: &Path, now: chrono::DateTime<chrono::Utc>) -> String {
    let base = format!("pre-restore-{}", now.format("%Y%m%dT%H%M%SZ"));
    let root = live.join(ARCHIVE_DIR);
    if !root.join(&base).exists() {
        return base;
    }
    let mut n = 2u32;
    loop {
        let cand = format!("{}-{}", base, n);
        if !root.join(&cand).exists() {
            return cand;
        }
        n += 1;
    }
}

// ── history ───────────────────────────────────────────────────────────────────────────────────────

/// Append one event to the restore history and fsync it. Ids, codes and counts only.
pub fn history(
    live: &Path,
    event: &str,
    ctx: Option<&RestoreContext>,
    snapshot_id: Option<&str>,
    code: Option<&str>,
    counts: Option<serde_json::Value>,
) -> Result<(), MediaError> {
    let mut line = serde_json::json!({
        "at": chrono::Utc::now().to_rfc3339(),
        "event": event,
        "appVersion": env!("CARGO_PKG_VERSION"),
    });
    let obj = line.as_object_mut().expect("object");
    if let Some(c) = ctx {
        obj.insert("snapshotId".into(), c.snapshot_id.clone().into());
        if !c.snapshot_created_at.is_empty() {
            obj.insert("snapshotCreatedAt".into(), c.snapshot_created_at.clone().into());
        }
        obj.insert("archiveId".into(), c.archive_id.clone().into());
    } else if let Some(s) = snapshot_id {
        obj.insert("snapshotId".into(), s.into());
    }
    if let Some(c) = code {
        obj.insert("code".into(), c.into());
    }
    if let Some(c) = counts {
        obj.insert("counts".into(), c);
    }
    let mut f = OpenOptions::new().create(true).append(true).open(live.join(HISTORY_FILE)).map_err(io("history open"))?;
    let mut raw = serde_json::to_vec(&line).map_err(io("history encode"))?;
    raw.push(b'\n');
    f.write_all(&raw).map_err(io("history write"))?;
    f.sync_all().map_err(io("history fsync"))
}

/// The same, where a failed write must not change the outcome (the step it records already happened).
pub fn note(live: &Path, event: &str, ctx: Option<&RestoreContext>, snapshot_id: Option<&str>, code: Option<&str>, counts: Option<serde_json::Value>) {
    let _ = history(live, event, ctx, snapshot_id, code, counts);
}

// ── free space ────────────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
thread_local! {
    /// Tests inject the free space of the volume (`Some(None)` = the probe cannot answer).
    pub static FAKE_FREE_SPACE: std::cell::Cell<Option<Option<u64>>> = std::cell::Cell::new(None);
}

fn free_space(path: &Path) -> Option<u64> {
    #[cfg(test)]
    {
        if let Some(v) = FAKE_FREE_SPACE.with(|c| c.get()) {
            return v;
        }
    }
    crate::volume_free_bytes(path)
}

/// Bytes a write of `bytes` needs including head-room.
pub fn with_margin(bytes: u64) -> u64 {
    bytes + std::cmp::max(SPACE_MARGIN_MIN, bytes / 20)
}

/// Fail closed: refuse when the volume cannot hold `bytes` (+ margin) — or when nobody can tell.
pub fn ensure_space(live: &Path, bytes: u64) -> Result<(), MediaError> {
    match free_space(live) {
        None => Err(MediaError::RestoreFreeSpaceUnknown),
        Some(free) if free < with_margin(bytes) => Err(MediaError::RestoreInsufficientSpace),
        Some(_) => Ok(()),
    }
}

pub fn volume_free(live: &Path) -> Option<u64> {
    free_space(live)
}

// ── fill-in ───────────────────────────────────────────────────────────────────────────────────────

/// One file the restored database lists, the backup did not carry, and the old media holds VERIFIED.
#[derive(Debug, Clone)]
pub struct FillItem {
    pub key: String,
    pub hash: String,
    pub bytes: u64,
}

/// What a fill-in pass found (and, after `apply`, did).
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FillReport {
    /// Rows the database lists whose file is already present in the restored media.
    pub present: u64,
    /// Rows whose file was copied back from the old media (identity + integrity proven).
    pub filled: u64,
    /// Rows whose old file failed the identity/integrity proof (name, size or hash) — left alone.
    pub refused: u64,
    /// Rows with no file in the old media either (e.g. lost before) — stay without a file.
    pub source_missing: u64,
}

/// Read every generation row of `db` (read-only). A missing table/db is "nothing listed".
fn listed_generations(db: &Path) -> Result<Vec<(String, String, u64)>, MediaError> {
    if !db.exists() {
        return Ok(Vec::new());
    }
    let conn = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(io("open db for fill-in"))?;
    let mut stmt = match conn.prepare("SELECT storage_key, stored_blob_hash, byte_size FROM media_blob_generations") {
        Ok(s) => s,
        Err(e) if e.to_string().contains("no such table") => return Ok(Vec::new()),
        Err(e) => return Err(MediaError::Io(format!("prepare fill-in: {e}"))),
    };
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                r.get::<_, Option<i64>>(2)?.unwrap_or(-1),
            ))
        })
        .map_err(io("query fill-in"))?;
    let mut out = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for row in rows {
        let (key, hash, size) = row.map_err(io("row fill-in"))?;
        let key = key.replace('\\', "/");
        if size < 0 || !seen.insert(key.clone()) {
            continue;
        }
        out.push((key, hash.to_ascii_lowercase(), size as u64));
    }
    Ok(out)
}

/// Is `src` provably the file the row describes? Storage key safe, file name == content hash, size and
/// SHA-256 equal. `verify_bytes = false` skips the hash (a quick estimate before the swap — never for a copy).
fn proven(src: &Path, key: &str, hash: &str, size: u64, verify_bytes: bool) -> bool {
    if is_unsafe_rel(key) || hash.len() < 16 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) || is_symlink(src) {
        return false;
    }
    let stem_ok = Path::new(key).file_stem().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case(hash)).unwrap_or(false);
    if !stem_ok {
        return false;
    }
    match fs::metadata(src) {
        Ok(m) if m.is_file() && m.len() == size => {}
        _ => return false,
    }
    if !verify_bytes {
        return true;
    }
    match fs::read(src) {
        Ok(b) => b.len() as u64 == size && sha256_hex(&b) == hash,
        Err(_) => false,
    }
}

/// Plan the fill-in: rows of `db` whose file is missing in `media_now` and proven in `media_old`.
pub fn plan_fill_in(db: &Path, media_now: &Path, media_old: &Path, verify_bytes: bool) -> Result<(Vec<FillItem>, FillReport), MediaError> {
    let mut rep = FillReport::default();
    let mut plan = Vec::new();
    for (key, hash, size) in listed_generations(db)? {
        if is_unsafe_rel(&key) {
            rep.refused += 1;
            continue;
        }
        if media_now.join(&key).exists() {
            rep.present += 1;
            continue;
        }
        let src = media_old.join(&key);
        if !src.exists() {
            rep.source_missing += 1;
            continue;
        }
        if proven(&src, &key, &hash, size, verify_bytes) {
            plan.push(FillItem { key, hash, bytes: size });
        } else {
            rep.refused += 1;
        }
    }
    Ok((plan, rep))
}

/// Copy the planned files back: temp copy (same volume) → fsync → re-hash the COPY → rename into place, never
/// over an existing file. A file that fails here is counted as refused and left alone.
fn apply_fill_in(live: &Path, media_old: &Path, plan: &[FillItem], rep: &mut FillReport) -> Result<(), MediaError> {
    if plan.is_empty() {
        return Ok(());
    }
    let tmp_dir = live.join(STAGING).join("fill-in");
    fs::create_dir_all(&tmp_dir).map_err(io("fill-in tmp dir"))?;
    for (n, it) in plan.iter().enumerate() {
        let dst = live.join("media").join(&it.key);
        if dst.exists() {
            rep.present += 1;
            continue;
        }
        let src = media_old.join(&it.key);
        if !proven(&src, &it.key, &it.hash, it.bytes, true) {
            rep.refused += 1;
            continue;
        }
        let tmp = tmp_dir.join(format!("{n}.tmp"));
        // One unreadable file is refused and the pass goes on — it must never hold up the archive step.
        let ok = (|| -> Result<bool, MediaError> {
            fs::copy(&src, &tmp).map_err(io("fill-in copy"))?;
            // FlushFileBuffers needs write access on Windows — a read-only handle cannot fsync.
            OpenOptions::new().write(true).open(&tmp).and_then(|f| f.sync_all()).map_err(io("fill-in fsync"))?;
            let b = fs::read(&tmp).map_err(io("fill-in reread"))?;
            if b.len() as u64 != it.bytes || sha256_hex(&b) != it.hash {
                return Ok(false);
            }
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent).map_err(io("fill-in mkdir"))?;
            }
            if dst.exists() {
                return Ok(false);
            }
            fs::rename(&tmp, &dst).map_err(io("fill-in rename"))?;
            Ok(true)
        })()
        .unwrap_or(false);
        if ok {
            rep.filled += 1;
        } else {
            let _ = fs::remove_file(&tmp);
            rep.refused += 1;
        }
    }
    Ok(())
}

// ── archive ───────────────────────────────────────────────────────────────────────────────────────

fn tree_size(dir: &Path) -> (u64, u64) {
    let (mut files, mut bytes) = (0u64, 0u64);
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if is_symlink(&p) {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(m) = fs::metadata(&p) {
                files += 1;
                bytes += m.len();
            }
        }
    }
    (files, bytes)
}

fn has_entries(dir: &Path) -> bool {
    fs::read_dir(dir).map(|mut r| r.next().is_some()).unwrap_or(false)
}

/// What the archive step did.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveReport {
    pub archive_id: Option<String>,
    pub files: u64,
    pub bytes: u64,
}

/// Rename the set-aside prior state into `restore-archive/<id>/`. An EMPTY set-aside (restore into a fresh
/// folder) leaves no archive. An already-renamed archive (a crash after the rename) is simply reported.
fn archive_rollback(live: &Path, ctx: &RestoreContext) -> Result<ArchiveReport, MediaError> {
    let rollback = live.join(ROLLBACK);
    let target_root = live.join(ARCHIVE_DIR);
    if !rollback.exists() {
        let done = target_root.join(&ctx.archive_id);
        if done.exists() {
            let (files, bytes) = tree_size(&done);
            return Ok(ArchiveReport { archive_id: Some(ctx.archive_id.clone()), files, bytes });
        }
        return Ok(ArchiveReport::default());
    }
    if !has_entries(&rollback) {
        fs::remove_dir(&rollback).map_err(io("remove empty rollback"))?;
        return Ok(ArchiveReport::default());
    }
    let (files, bytes) = tree_size(&rollback);
    let meta = serde_json::json!({
        "archiveId": ctx.archive_id,
        "kind": "pre-restore state",
        "archivedAt": chrono::Utc::now().to_rfc3339(),
        "replacedBySnapshotId": ctx.snapshot_id,
        "replacedBySnapshotCreatedAt": ctx.snapshot_created_at,
        "files": files,
        "bytes": bytes,
        "note": "The databases and media as they were before the restore. Kept until the owner deletes it.",
    });
    let mut f = File::create(rollback.join(ARCHIVE_META)).map_err(io("archive meta open"))?;
    f.write_all(serde_json::to_string_pretty(&meta).map_err(io("archive meta encode"))?.as_bytes()).map_err(io("archive meta write"))?;
    f.sync_all().map_err(io("archive meta fsync"))?;
    drop(f);
    fs::create_dir_all(&target_root).map_err(io("archive root"))?;
    let mut id = ctx.archive_id.clone();
    if target_root.join(&id).exists() {
        id = new_archive_id(live, chrono::Utc::now());
    }
    fs::rename(&rollback, target_root.join(&id)).map_err(io("archive rename"))?;
    Ok(ArchiveReport { archive_id: Some(id), files, bytes })
}

/// Total size of all archives (for the preview and the history).
pub fn archives_size(live: &Path) -> (u64, u64) {
    let root = live.join(ARCHIVE_DIR);
    let count = fs::read_dir(&root).map(|r| r.flatten().filter(|e| e.path().is_dir()).count() as u64).unwrap_or(0);
    let (_, bytes) = tree_size(&root);
    (count, bytes)
}

// ── after the commit ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FinishReport {
    pub fill: FillReport,
    pub archive: ArchiveReport,
}

/// Everything after the durable `done`, idempotent: fill-in, then archive. `step` lets tests stop between
/// the two to prove that `recover()` finishes the job. On error nothing is deleted — the set-aside state
/// stays where it is and `recover()` retries at the next boot.
pub fn finish_after_commit(
    live: &Path,
    ctx: &RestoreContext,
    step: &dyn Fn(&'static str) -> Result<(), MediaError>,
) -> Result<FinishReport, MediaError> {
    let media_old = live.join(ROLLBACK).join("media");
    let mut fill = FillReport::default();
    if media_old.exists() {
        let (plan, rep) = plan_fill_in(&live.join(FRONT_DB), &live.join("media"), &media_old, true)?;
        fill = rep;
        apply_fill_in(live, &media_old, &plan, &mut fill)?;
    }
    step("filled-in")?;
    let archive = archive_rollback(live, ctx)?;
    step("archived")?;
    Ok(FinishReport { fill, archive })
}

/// Paths a restore touches that the rest of the system must treat as the owner's data (never transient).
pub fn archive_root(live: &Path) -> PathBuf {
    live.join(ARCHIVE_DIR)
}

#[cfg(test)]
#[path = "restore_safety_tests.rs"]
mod restore_safety_tests;
