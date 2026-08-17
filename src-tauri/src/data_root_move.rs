// ════════════════════════════════════════════════════════════════════════════
// DATA-ROOT-I1 / B2 — moving the data root, without ever betting the data on the move.
//
// ## The one rule
//
//     COPY → VERIFY → SWITCH THE LOCATOR → RELAUNCH
//
// Never "move the source and hope the target works". The source root is still complete, still
// openable and still correct at every instant of this operation, including every crash window. It
// is not deleted here, and B2 ships no function that deletes it — after a successful move two
// complete roots exist on purpose, and the locator alone decides which one is live.
//
// ## Why the whole thing runs at boot
//
// A move must not copy a database somebody is writing to. Quiescing a running app — sql.js in the
// renderer, the LAN server, the mobile drain, the media ingest, the GC — is possible but it is a
// promise that has to hold for every future writer anyone adds. The boot path needs no promise: at
// the point this runs, no database is open, no server is bound, no worker exists, and the renderer
// has not been created. That is the same reason restore, backup and media-GC already run there.
//
// So the UI does not move anything. It writes an INTENT, and the existing coordinated relaunch
// (flush the business DB durably → stop the server → confirm the port is free → relaunch) carries
// us into a process where the move is trivially safe. The move then finishes before anything opens,
// and that same process continues on the NEW root — so there is no hot switch of a live renderer
// either: the renderer that comes up has only ever known the target.
//
// ## The identity does not change
//
// A move does not create a new data set, so it does not create a new `rootId`. The marker is copied
// verbatim and the locator merely changes its path. That is what makes recovery decidable: after a
// crash, "this root carries the id my intent names" is a fact, not a guess.
//
// ## Crash windows
//
// The intent's phase is the whole recovery contract:
//
//   prepared         nothing copied yet                    → (re)start the copy, source untouched
//   copying          a partial staging tree exists         → delete it and restart the copy
//   verified         staging complete + proven             → redo rather than half-trust it
//   target_finalized target is complete and proven         → re-validate, then switch (or abort)
//   locator_switched the commit already happened           → validate the target; on failure ROLL
//                                                            BACK to the source the intent names
//
// Before the locator write the source is authoritative, always. After it the target is — unless the
// target cannot be opened safely, in which case the rollback is allowed precisely because the intent
// binds an explicit source path and a matching `rootId`. That is move recovery, not a "pick the best
// root" heuristic, and it is the only situation in which the locator is ever rewritten backwards.
//
// A move that keeps failing must not brick the app: after MAX_ATTEMPTS the intent is abandoned, the
// staging is removed and the app starts normally on the source.
// ════════════════════════════════════════════════════════════════════════════

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use crate::data_root::{self, DataRoot};

pub const MOVE_INTENT_FILENAME: &str = "data-move-intent.json";
pub const MOVE_INTENT_SCHEMA_VERSION: u32 = 1;
/// Staging directory name: `<target parent>/.lataif-move-<moveId>`. Same volume as the target, so
/// the finalisation is a rename and therefore atomic.
pub const STAGING_PREFIX: &str = ".lataif-move-";
/// Headroom on top of the measured source size.
const SPACE_HEADROOM_NUM: u64 = 105;
const SPACE_HEADROOM_DEN: u64 = 100;
/// After this many boots that failed to complete the move, give up and keep the source.
const MAX_ATTEMPTS: u32 = 2;

/// Everything inside a data root that is transient and must NOT travel with it: half-finished
/// operations of the very machinery that is quiesced right now.
const EXCLUDED_EXACT: &[&str] = &[
    ".restore-staging",
    ".restore-rollback",
    ".restore-journal",
    ".restore-intent",
    ".backup-intent",
    ".gc-intent",
];
const EXCLUDED_PREFIX: &[&str] = &["backup-ws-", "data-location.tmp-", ".lataif-data-root.tmp-", STAGING_PREFIX];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MovePhase {
    Prepared,
    Copying,
    Verified,
    TargetFinalized,
    LocatorSwitched,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveIntent {
    pub schema_version: u32,
    pub move_id: String,
    /// The data set's identity. Unchanged by the move — see the module header.
    pub root_id: String,
    pub source_root: String,
    pub target_root: String,
    pub staging_root: String,
    pub phase: MovePhase,
    #[serde(default)]
    pub attempts: u32,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MoveError {
    NotAbsolute,
    NotNormalizable,
    TargetUnreachable,
    TargetNotWritable,
    TargetIsSource,
    OverlapsSource,
    OverlapsBackupRoot,
    OverlapsAppFolder,
    TargetNotEmpty,
    TargetHasLataifData,
    InsufficientSpace,
    FreeSpaceUnknown,
    ReparsePointInSource,
    OperationPending,
    MoveAlreadyPending,
    CopyFailed(String),
    ManifestMismatch,
    HashMismatch,
    DbIntegrityFailed,
    MediaReferenceMissing,
    RootIdMismatch,
    FinalizeFailed(String),
    LocatorWriteFailed,
    Io(String),
}

impl MoveError {
    pub fn code(&self) -> &'static str {
        match self {
            MoveError::NotAbsolute => "MOVE_TARGET_NOT_ABSOLUTE",
            MoveError::NotNormalizable => "MOVE_TARGET_NOT_NORMALIZABLE",
            MoveError::TargetUnreachable => "MOVE_TARGET_UNREACHABLE",
            MoveError::TargetNotWritable => "MOVE_TARGET_NOT_WRITABLE",
            MoveError::TargetIsSource => "MOVE_TARGET_IS_SOURCE",
            MoveError::OverlapsSource => "MOVE_TARGET_OVERLAPS_SOURCE",
            MoveError::OverlapsBackupRoot => "MOVE_TARGET_OVERLAPS_BACKUP_ROOT",
            MoveError::OverlapsAppFolder => "MOVE_TARGET_OVERLAPS_APP_FOLDER",
            MoveError::TargetNotEmpty => "MOVE_TARGET_NOT_EMPTY",
            MoveError::TargetHasLataifData => "MOVE_TARGET_HAS_LATAIF_DATA",
            MoveError::InsufficientSpace => "MOVE_INSUFFICIENT_SPACE",
            MoveError::FreeSpaceUnknown => "MOVE_FREE_SPACE_UNKNOWN",
            MoveError::ReparsePointInSource => "MOVE_SOURCE_HAS_REPARSE_POINT",
            MoveError::OperationPending => "MOVE_OPERATION_PENDING",
            MoveError::MoveAlreadyPending => "MOVE_ALREADY_PENDING",
            MoveError::CopyFailed(_) => "MOVE_COPY_FAILED",
            MoveError::ManifestMismatch => "MOVE_MANIFEST_MISMATCH",
            MoveError::HashMismatch => "MOVE_HASH_MISMATCH",
            MoveError::DbIntegrityFailed => "MOVE_DB_INTEGRITY_FAILED",
            MoveError::MediaReferenceMissing => "MOVE_MEDIA_REFERENCE_MISSING",
            MoveError::RootIdMismatch => "MOVE_ROOT_ID_MISMATCH",
            MoveError::FinalizeFailed(_) => "MOVE_FINALIZE_FAILED",
            MoveError::LocatorWriteFailed => "MOVE_LOCATOR_WRITE_FAILED",
            MoveError::Io(_) => "MOVE_IO",
        }
    }
}

fn io<E: std::fmt::Display>(ctx: &'static str) -> impl Fn(E) -> MoveError {
    move |e| MoveError::Io(format!("{ctx}: {e}"))
}

// ════════════════════════════════════════════════════════════════════════════
// Path normalisation — fail-closed.
//
// B1's overlap helper falls back to comparing raw paths when `canonicalize` fails. For a display
// check that is fine. For the decision "is it safe to copy a database here" it is not: a comparison
// that silently degrades is a comparison that can be made to say no when it means yes. A move target
// usually does not exist yet, so canonicalising it directly is not an option either — instead we
// canonicalise the deepest ancestor that DOES exist and re-attach the remaining components. Anything
// that cannot be normalised that way is refused outright.
// ════════════════════════════════════════════════════════════════════════════

pub fn normalize_for_compare(p: &Path) -> Result<PathBuf, MoveError> {
    if !p.is_absolute() {
        return Err(MoveError::NotAbsolute);
    }
    // Reject `..` and `.` outright rather than resolving them: a move path is chosen by a folder
    // dialog, so a relative segment is never legitimate here.
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut probe = p.to_path_buf();
    loop {
        if let Ok(c) = fs::canonicalize(&probe) {
            let mut out = c;
            for seg in tail.iter().rev() {
                out.push(seg);
            }
            return Ok(out);
        }
        let name = match probe.file_name() {
            Some(n) => n.to_os_string(),
            None => return Err(MoveError::NotNormalizable), // reached the root and it does not resolve
        };
        match probe.components().next_back() {
            Some(Component::Normal(_)) => {}
            _ => return Err(MoveError::NotNormalizable),
        }
        tail.push(name);
        if !probe.pop() {
            return Err(MoveError::NotNormalizable);
        }
    }
}

/// Same directory, or one contains the other — decided on normalised paths, component by component.
/// Fails closed: a path that cannot be normalised is an error, never "probably fine".
pub fn overlaps_strict(a: &Path, b: &Path) -> Result<bool, MoveError> {
    let ca = normalize_for_compare(a)?;
    let cb = normalize_for_compare(b)?;
    Ok(ca == cb || ca.starts_with(&cb) || cb.starts_with(&ca))
}

// ════════════════════════════════════════════════════════════════════════════
// Preflight
// ════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovePlan {
    pub move_id: String,
    pub root_id: String,
    pub source_root: String,
    pub target_root: String,
    pub staging_root: String,
    pub required_bytes: u64,
    pub free_bytes: u64,
    pub file_count: usize,
}

fn is_reparse(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
        || is_windows_reparse(p)
}

#[cfg(windows)]
fn is_windows_reparse(p: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    match fs::symlink_metadata(p) {
        Ok(m) => m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0,
        Err(_) => true, // unreadable → treat as unsafe
    }
}
#[cfg(not(windows))]
fn is_windows_reparse(_p: &Path) -> bool {
    false
}

fn excluded(name: &str) -> bool {
    EXCLUDED_EXACT.contains(&name) || EXCLUDED_PREFIX.iter().any(|p| name.starts_with(p))
}

/// Every file the move carries, as `relative/path -> byte size`. Rejects the whole operation if a
/// reparse point sits anywhere inside the tree: following one would copy from outside the root, and
/// not following it would silently drop data. Neither is acceptable, so we refuse and say so.
pub fn scan_source(root: &Path) -> Result<BTreeMap<String, u64>, MoveError> {
    let mut out = BTreeMap::new();
    walk(root, root, &mut out)?;
    Ok(out)
}

fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, u64>) -> Result<(), MoveError> {
    for entry in fs::read_dir(dir).map_err(io("read source dir"))? {
        let entry = entry.map_err(io("read source entry"))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if dir == root && excluded(&name) {
            continue;
        }
        if is_reparse(&path) {
            return Err(MoveError::ReparsePointInSource);
        }
        let ft = entry.file_type().map_err(io("file type"))?;
        if ft.is_dir() {
            walk(root, &path, out)?;
        } else if ft.is_file() {
            let rel = rel_key(root, &path)?;
            let size = entry.metadata().map_err(io("metadata"))?.len();
            out.insert(rel, size);
        }
    }
    Ok(())
}

fn rel_key(root: &Path, path: &Path) -> Result<String, MoveError> {
    let rel = path.strip_prefix(root).map_err(|_| MoveError::Io("path escaped root".into()))?;
    let mut parts = Vec::new();
    for c in rel.components() {
        match c {
            Component::Normal(s) => parts.push(s.to_string_lossy().to_string()),
            _ => return Err(MoveError::Io("unsafe component".into())),
        }
    }
    Ok(parts.join("/"))
}

/// Does this directory already hold LATAIF data? A marker, either database or a media folder all
/// count. We never merge into or adopt such a directory — that is how two data sets become one
/// unexplainable one.
fn holds_lataif_data(dir: &Path) -> bool {
    dir.join(data_root::MARKER_FILENAME).exists()
        || dir.join(data_root::BUSINESS_DB_FILENAME).exists()
        || dir.join(data_root::SYNC_SERVER_DB_FILENAME).exists()
        || dir.join(data_root::MEDIA_DIRNAME).is_dir()
}

/// What the copy will need: the measured source size plus headroom.
pub fn required_bytes(source_total: u64) -> u64 {
    source_total.saturating_mul(SPACE_HEADROOM_NUM) / SPACE_HEADROOM_DEN
}

/// Split out so the refusal is testable without filling a disk. An unknown free-space figure is its
/// own error upstream — "we could not tell, so we copied anyway" is not an option.
pub fn check_space(required: u64, free: u64) -> Result<(), MoveError> {
    if free < required {
        return Err(MoveError::InsufficientSpace);
    }
    Ok(())
}

fn dir_is_empty(dir: &Path) -> Result<bool, MoveError> {
    Ok(fs::read_dir(dir).map_err(io("read target dir"))?.next().is_none())
}

fn write_probe(dir: &Path) -> std::io::Result<()> {
    use std::io::Write;
    let probe = dir.join(".lataif_move_write_test");
    {
        let mut f = fs::File::create(&probe)?;
        f.write_all(b"lataif-move-write-test")?;
        f.sync_all()?;
    }
    fs::remove_file(&probe)
}

/// Validate a chosen target completely, BEFORE a single byte is copied. Creates nothing except the
/// target directory itself (and only when it does not exist yet), and removes its own probe file.
pub fn preflight(
    source: &DataRoot,
    target_raw: &str,
    backups_root: &Path,
    app_folder: Option<&Path>,
) -> Result<MovePlan, MoveError> {
    let target = PathBuf::from(target_raw.trim());
    if target_raw.trim().is_empty() || !target.is_absolute() {
        return Err(MoveError::NotAbsolute);
    }
    // Normalise first: every decision below is made on normalised paths or not at all.
    let target_n = normalize_for_compare(&target)?;
    let source_n = normalize_for_compare(source.path())?;

    if target_n == source_n {
        return Err(MoveError::TargetIsSource);
    }
    if overlaps_strict(&target, source.path())? {
        return Err(MoveError::OverlapsSource);
    }
    // The live configuration has backups at `E:\`; choosing `E:\LATAIF\Data` would put the data
    // INSIDE the backup root. Refused, and never fixed silently by rewriting the backup location.
    if overlaps_strict(&target, backups_root)? {
        return Err(MoveError::OverlapsBackupRoot);
    }
    if let Some(app) = app_folder {
        if overlaps_strict(&target, app)? {
            return Err(MoveError::OverlapsAppFolder);
        }
    }

    // Reachability + emptiness. A target that already holds LATAIF data is refused outright.
    if target.exists() {
        if !target.is_dir() {
            return Err(MoveError::TargetUnreachable);
        }
        if holds_lataif_data(&target) {
            return Err(MoveError::TargetHasLataifData);
        }
        if !dir_is_empty(&target)? {
            return Err(MoveError::TargetNotEmpty);
        }
    } else {
        // Only the target itself may be created here, and only to prove it can be.
        fs::create_dir_all(&target).map_err(|_| MoveError::TargetNotWritable)?;
    }
    write_probe(&target).map_err(|_| MoveError::TargetNotWritable)?;

    let manifest = scan_source(source.path())?;
    let required = required_bytes(manifest.values().sum());
    let free = crate::volume_free_bytes(&target).ok_or(MoveError::FreeSpaceUnknown)?;
    check_space(required, free)?;

    let move_id = uuid::Uuid::new_v4().as_simple().to_string();
    let staging = target
        .parent()
        .ok_or(MoveError::NotNormalizable)?
        .join(format!("{STAGING_PREFIX}{move_id}"));

    Ok(MovePlan {
        move_id,
        root_id: source.root_id().to_string(),
        source_root: source.path().to_string_lossy().to_string(),
        target_root: target.to_string_lossy().to_string(),
        staging_root: staging.to_string_lossy().to_string(),
        required_bytes: required,
        free_bytes: free,
        file_count: manifest.len(),
    })
}

// ════════════════════════════════════════════════════════════════════════════
// Intent file (next to the locator, OUTSIDE the data root — a move is precisely the operation
// during which "inside the data root" is ambiguous)
// ════════════════════════════════════════════════════════════════════════════

pub fn intent_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(MOVE_INTENT_FILENAME)
}

pub fn read_intent(app_data_dir: &Path) -> Option<MoveIntent> {
    let raw = fs::read(intent_path(app_data_dir)).ok()?;
    let i: MoveIntent = serde_json::from_slice(&raw).ok()?;
    if i.schema_version != MOVE_INTENT_SCHEMA_VERSION {
        return None;
    }
    Some(i)
}

fn write_intent(app_data_dir: &Path, intent: &MoveIntent) -> Result<(), MoveError> {
    let bytes = serde_json::to_vec_pretty(intent).map_err(io("encode intent"))?;
    data_root::write_atomic(&intent_path(app_data_dir), &bytes)
        .map_err(|e| MoveError::Io(e.code().to_string()))
}

pub fn clear_intent(app_data_dir: &Path) {
    let _ = fs::remove_file(intent_path(app_data_dir));
}

/// Durably record the scheduled move. Refuses while another move is pending, or while any other
/// boot-time operation is queued — a move is an exclusive maintenance state.
pub fn schedule(app_data_dir: &Path, source: &DataRoot, plan: &MovePlan) -> Result<(), MoveError> {
    if read_intent(app_data_dir).is_some() {
        return Err(MoveError::MoveAlreadyPending);
    }
    for marker in EXCLUDED_EXACT {
        if source.path().join(marker).exists() {
            return Err(MoveError::OperationPending);
        }
    }
    write_intent(
        app_data_dir,
        &MoveIntent {
            schema_version: MOVE_INTENT_SCHEMA_VERSION,
            move_id: plan.move_id.clone(),
            root_id: plan.root_id.clone(),
            source_root: plan.source_root.clone(),
            target_root: plan.target_root.clone(),
            staging_root: plan.staging_root.clone(),
            phase: MovePhase::Prepared,
            attempts: 0,
            created_at: data_root::now_iso(),
        },
    )
}

// ════════════════════════════════════════════════════════════════════════════
// Copy + verification
// ════════════════════════════════════════════════════════════════════════════

fn sha256_file(p: &Path) -> Result<String, MoveError> {
    let bytes = fs::read(p).map_err(io("hash read"))?;
    Ok(crate::media::storage::sha256_hex(&bytes))
}

fn copy_tree(source: &Path, staging: &Path, manifest: &BTreeMap<String, u64>) -> Result<(), MoveError> {
    fs::create_dir_all(staging).map_err(|e| MoveError::CopyFailed(e.to_string()))?;
    for rel in manifest.keys() {
        let src = source.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        let dst = staging.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| MoveError::CopyFailed(e.to_string()))?;
        }
        fs::copy(&src, &dst).map_err(|e| MoveError::CopyFailed(e.to_string()))?;
    }
    Ok(())
}

/// Collapse any write-ahead log into the main database so the copy is self-contained and can be
/// integrity-checked read-only. Safe here and nowhere else: at boot nothing else has the file open.
fn checkpoint_db(p: &Path) {
    if !p.exists() {
        return;
    }
    if let Ok(conn) = Connection::open(p) {
        let _ = conn.pragma_update(None, "journal_mode", "DELETE");
        let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
    }
}

fn check_db(p: &Path) -> Result<(), MoveError> {
    if !p.exists() {
        return Ok(()); // a server DB only exists once LAN sync has run
    }
    let conn = Connection::open_with_flags(p, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| MoveError::DbIntegrityFailed)?;
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|_| MoveError::DbIntegrityFailed)?;
    if integrity.to_ascii_lowercase() != "ok" {
        return Err(MoveError::DbIntegrityFailed);
    }
    let mut stmt = conn.prepare("PRAGMA foreign_key_check").map_err(|_| MoveError::DbIntegrityFailed)?;
    let violations = stmt
        .query_map([], |_| Ok(()))
        .map_err(|_| MoveError::DbIntegrityFailed)?
        .count();
    if violations > 0 {
        return Err(MoveError::DbIntegrityFailed);
    }
    Ok(())
}

/// Every media blob the copied business DB still references must exist in the copied media tree.
/// The reference set is the same fail-closed one the media GC uses, so "referenced" means the same
/// thing in both directions.
fn check_media(root: &Path) -> Result<(), MoveError> {
    let db = root.join(data_root::BUSINESS_DB_FILENAME);
    if !db.exists() {
        return Ok(());
    }
    let media_root = root.join(data_root::MEDIA_DIRNAME);
    let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| MoveError::DbIntegrityFailed)?;
    let mut stmt = match conn.prepare("SELECT storage_key FROM media_blob_generations") {
        Ok(s) => s,
        Err(_) => return Ok(()), // table absent → nothing is referenced yet
    };
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|_| MoveError::DbIntegrityFailed)?;
    for row in rows {
        let key = row.map_err(|_| MoveError::DbIntegrityFailed)?;
        let norm = key.replace('\\', "/");
        // A stored key must stay inside the media root — an escape is a corrupted reference, not a
        // missing file, and must never be "found" by walking out of the tree.
        if norm.starts_with('/') || norm.split('/').any(|s| s.is_empty() || s == "." || s == "..") {
            return Err(MoveError::MediaReferenceMissing);
        }
        if !media_root.join(norm.replace('/', std::path::MAIN_SEPARATOR_STR)).exists() {
            return Err(MoveError::MediaReferenceMissing);
        }
    }
    Ok(())
}

/// Prove the copy IS the source: same relative paths, same count, same sizes, same SHA-256 — then
/// prove the copy is usable: both databases intact, every referenced blob present, the marker still
/// naming the same data set.
fn verify(source: &Path, staged: &Path, expected: &BTreeMap<String, u64>, root_id: &str) -> Result<(), MoveError> {
    // AUTOMATION ONLY — compiled out of every production build. There is exactly one property worth
    // proving against the real app rather than a temp directory: that a verification failure never
    // reaches the locator. Reproducing a genuine bit-flip mid-copy in an E2E is not practical, so the
    // e2e binary can be told to fail this step, and the suite then asserts what the app does about it.
    #[cfg(feature = "e2e")]
    if std::env::var("LATAIF_E2E_MOVE_FAIL_VERIFY").is_ok() {
        return Err(MoveError::HashMismatch);
    }
    let got = scan_source(staged)?;
    if got.len() != expected.len() {
        return Err(MoveError::ManifestMismatch);
    }
    for (rel, size) in expected {
        match got.get(rel) {
            Some(s) if s == size => {}
            _ => return Err(MoveError::ManifestMismatch),
        }
        let a = sha256_file(&source.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR)))?;
        let b = sha256_file(&staged.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR)))?;
        if a != b {
            return Err(MoveError::HashMismatch);
        }
    }
    check_db(&staged.join(data_root::BUSINESS_DB_FILENAME))?;
    check_db(&staged.join(data_root::SYNC_SERVER_DB_FILENAME))?;
    check_media(staged)?;
    match data_root::read_marker(staged) {
        Ok(Some(m)) if m.root_id == root_id => Ok(()),
        _ => Err(MoveError::RootIdMismatch),
    }
}

/// The cheap re-validation done on an already-finalised target before the locator is switched, and
/// again when recovering a crash that happened around the switch.
fn validate_final_root(root: &Path, root_id: &str) -> Result<(), MoveError> {
    if !root.is_dir() {
        return Err(MoveError::TargetUnreachable);
    }
    match data_root::read_marker(root) {
        Ok(Some(m)) if m.root_id == root_id => {}
        _ => return Err(MoveError::RootIdMismatch),
    }
    check_db(&root.join(data_root::BUSINESS_DB_FILENAME))?;
    check_db(&root.join(data_root::SYNC_SERVER_DB_FILENAME))?;
    check_media(root)
}

// ════════════════════════════════════════════════════════════════════════════
// Boot-time execution + recovery
// ════════════════════════════════════════════════════════════════════════════

/// The result of reconciling a pending move at boot, for logging only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MoveOutcome {
    /// No intent — nothing happened.
    None,
    /// The move completed and the locator now names the target.
    Switched,
    /// The move was abandoned; the source is still the active root.
    Aborted(&'static str),
    /// The locator had already been switched but the target would not open; we went back.
    RolledBack,
}

/// Resolve the active data root, reconciling any pending move FIRST.
///
/// This is the only entry point the boot path uses. It exists as one function because the two
/// questions — "where is the data" and "is a move half-done" — cannot be answered independently:
/// after the locator write the answer to the first is the target, and only the intent knows whether
/// that target was ever proven.
pub fn resolve_with_pending_move(
    app_data_dir: &Path,
) -> Result<(DataRoot, MoveOutcome), data_root::DataRootError> {
    let Some(intent) = read_intent(app_data_dir) else {
        return Ok((data_root::resolve(app_data_dir)?, MoveOutcome::None));
    };
    let outcome = reconcile(app_data_dir, intent);
    Ok((data_root::resolve(app_data_dir)?, outcome))
}

/// Best-effort removal of a staging tree. Never touches anything but the path the intent names, and
/// only when that path still carries the staging prefix.
fn discard_staging(staging: &Path) {
    let named_like_staging = staging
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with(STAGING_PREFIX))
        .unwrap_or(false);
    if named_like_staging && staging.is_dir() {
        let _ = fs::remove_dir_all(staging);
    }
}

fn abort(app_data_dir: &Path, intent: &MoveIntent, why: &'static str) -> MoveOutcome {
    discard_staging(Path::new(&intent.staging_root));
    clear_intent(app_data_dir);
    eprintln!("[data-move] aborted ({why}) — the source root remains active");
    MoveOutcome::Aborted(why)
}

fn reconcile(app_data_dir: &Path, intent: MoveIntent) -> MoveOutcome {
    match intent.phase {
        // The commit already happened. The locator names the target; all that is left is to prove
        // the target opens — and to go back if it does not.
        MovePhase::LocatorSwitched => {
            let target = PathBuf::from(&intent.target_root);
            match validate_final_root(&target, &intent.root_id) {
                Ok(()) => {
                    clear_intent(app_data_dir);
                    eprintln!("[data-move] completed — active root is now the target");
                    MoveOutcome::Switched
                }
                Err(e) => {
                    // ROLLBACK. Allowed here and nowhere else: the intent binds an explicit source
                    // path and the same rootId, so this is not "pick a root", it is "undo a move".
                    eprintln!("[data-move] target unusable after switch ({}) — rolling back", e.code());
                    let source = PathBuf::from(&intent.source_root);
                    if data_root::set_locator(app_data_dir, &source, &intent.root_id).is_err() {
                        eprintln!("[data-move] ROLLBACK FAILED — locator not rewritten");
                        return MoveOutcome::Aborted("rollback_failed");
                    }
                    clear_intent(app_data_dir);
                    MoveOutcome::RolledBack
                }
            }
        }
        // The target is complete and was proven before the crash. Re-prove it cheaply, then commit.
        MovePhase::TargetFinalized => {
            let target = PathBuf::from(&intent.target_root);
            match validate_final_root(&target, &intent.root_id) {
                Ok(()) => commit(app_data_dir, &intent),
                Err(_) => {
                    // Remove the finalised COPY (never the source) so a retry cannot find a stale
                    // target sitting in its way.
                    let _ = fs::remove_dir_all(&target);
                    abort(app_data_dir, &intent, "target_validation_failed")
                }
            }
        }
        // Nothing usable exists yet in any of these. Do the work (or give up if it keeps failing).
        MovePhase::Prepared | MovePhase::Copying | MovePhase::Verified => {
            // A crash can land between the staging→target rename and the phase write. The target then
            // already exists, complete, carrying OUR rootId — which is exactly the proof
            // `target_finalized` relies on. Redoing the copy in that state would hit "the target
            // already holds LATAIF data" and strand a complete copy nobody can use, so recognise it.
            let finished_target = PathBuf::from(&intent.target_root);
            if validate_final_root(&finished_target, &intent.root_id).is_ok() {
                discard_staging(Path::new(&intent.staging_root));
                return commit(app_data_dir, &intent);
            }
            if intent.attempts >= MAX_ATTEMPTS {
                return abort(app_data_dir, &intent, "too_many_attempts");
            }
            let mut i = intent.clone();
            i.attempts += 1;
            i.phase = MovePhase::Copying;
            if write_intent(app_data_dir, &i).is_err() {
                return abort(app_data_dir, &intent, "intent_write_failed");
            }
            match perform(app_data_dir, &i) {
                Ok(outcome) => outcome,
                Err(e) => {
                    eprintln!("[data-move] failed ({}) — the source root remains active", e.code());
                    abort(app_data_dir, &i, "move_failed")
                }
            }
        }
    }
}

/// Re-prove every safety property at the moment of the copy, against the paths the intent names.
///
/// The UI's preflight ran in a DIFFERENT PROCESS, before a relaunch. Between the two, the owner can
/// have pointed backups somewhere else, a junction can have appeared at the target, a folder can
/// have been filled, a drive can have shrunk. A preflight is a decision aid; this is the gate.
fn revalidate_at_boot(intent: &MoveIntent, source: &Path, target: &Path) -> Result<(), MoveError> {
    // Normalisation first — a path that cannot be compared safely is not copied to.
    let target_n = normalize_for_compare(target)?;
    let source_n = normalize_for_compare(source)?;
    if target_n == source_n {
        return Err(MoveError::TargetIsSource);
    }
    if overlaps_strict(target, source)? {
        return Err(MoveError::OverlapsSource);
    }
    // The backup root is read fresh: it is owner-configurable and may have changed since the plan.
    let backups = crate::media::backup_location::resolve_root(source);
    if overlaps_strict(target, &backups)? {
        return Err(MoveError::OverlapsBackupRoot);
    }
    if let Some(app) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        if overlaps_strict(target, &app)? {
            return Err(MoveError::OverlapsAppFolder);
        }
    }
    // A reparse point at the target (or at the staging parent) would take the copy off this volume.
    if is_reparse(target) {
        return Err(MoveError::TargetUnreachable);
    }
    if target.exists() {
        if !target.is_dir() {
            return Err(MoveError::TargetUnreachable);
        }
        if holds_lataif_data(target) {
            return Err(MoveError::TargetHasLataifData);
        }
        if !dir_is_empty(target)? {
            return Err(MoveError::TargetNotEmpty);
        }
    }
    let parent = target.parent().ok_or(MoveError::NotNormalizable)?;
    fs::create_dir_all(parent).map_err(|_| MoveError::TargetNotWritable)?;
    write_probe(parent).map_err(|_| MoveError::TargetNotWritable)?;
    // And the disk still has to hold it.
    let required = required_bytes(scan_source(source)?.values().sum());
    let free = crate::volume_free_bytes(parent).ok_or(MoveError::FreeSpaceUnknown)?;
    check_space(required, free)?;
    let _ = intent;
    Ok(())
}

/// Copy → verify → finalise → commit. Every failure leaves the source authoritative and untouched.
fn perform(app_data_dir: &Path, intent: &MoveIntent) -> Result<MoveOutcome, MoveError> {
    let source = PathBuf::from(&intent.source_root);
    let target = PathBuf::from(&intent.target_root);
    let staging = PathBuf::from(&intent.staging_root);

    if !source.is_dir() {
        return Err(MoveError::Io("source root missing".into()));
    }
    revalidate_at_boot(intent, &source, &target)?;
    // A retry must never accumulate staging trees.
    discard_staging(&staging);

    // Collapse the write-ahead logs BEFORE the manifest is taken, so the copy is self-contained and
    // the hashes describe the bytes that will actually be verified.
    checkpoint_db(&source.join(data_root::BUSINESS_DB_FILENAME));
    checkpoint_db(&source.join(data_root::SYNC_SERVER_DB_FILENAME));

    let manifest = scan_source(&source)?;
    copy_tree(&source, &staging, &manifest)?;

    verify(&source, &staging, &manifest, &intent.root_id)?;
    let mut i = intent.clone();
    i.phase = MovePhase::Verified;
    write_intent(app_data_dir, &i)?;

    // Finalise INSIDE the target volume: staging and target share a parent, so this is a rename.
    if target.exists() {
        if holds_lataif_data(&target) {
            return Err(MoveError::TargetHasLataifData); // never overwrite a real data set
        }
        if !dir_is_empty(&target)? {
            return Err(MoveError::TargetNotEmpty);
        }
        fs::remove_dir(&target).map_err(|e| MoveError::FinalizeFailed(e.to_string()))?;
    }
    fs::rename(&staging, &target).map_err(|e| MoveError::FinalizeFailed(e.to_string()))?;
    i.phase = MovePhase::TargetFinalized;
    write_intent(app_data_dir, &i)?;

    validate_final_root(&target, &intent.root_id)?;
    Ok(commit(app_data_dir, &i))
}

/// The commit point: one atomic locator write. Before it the source is live, after it the target is.
fn commit(app_data_dir: &Path, intent: &MoveIntent) -> MoveOutcome {
    let target = PathBuf::from(&intent.target_root);
    if data_root::set_locator(app_data_dir, &target, &intent.root_id).is_err() {
        return abort(app_data_dir, intent, "locator_write_failed");
    }
    let mut i = intent.clone();
    i.phase = MovePhase::LocatorSwitched;
    // If this bookkeeping write fails the locator is already committed; the next boot sees a
    // TargetFinalized intent pointing at a target that validates, and commits again — idempotently.
    let _ = write_intent(app_data_dir, &i);
    clear_intent(app_data_dir);
    eprintln!("[data-move] committed — active root is now the target");
    MoveOutcome::Switched
}

// ════════════════════════════════════════════════════════════════════════════
// Temp-file cleanup (the B1 orphan finding)
// ════════════════════════════════════════════════════════════════════════════

/// Remove OUR OWN atomic-write leftovers next to the locator. Only the exact prefixes this code
/// writes, only in the AppData directory, and never while a move is pending — a recoverable move's
/// staging tree and intent must survive any cleanup.
pub fn cleanup_own_temp_files(app_data_dir: &Path) -> usize {
    if read_intent(app_data_dir).is_some() {
        return 0;
    }
    let mut removed = 0;
    let Ok(entries) = fs::read_dir(app_data_dir) else { return 0 };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let ours = name.starts_with("data-location.tmp-")
            || name.starts_with(".lataif-data-root.tmp-")
            || name.starts_with("data-move-intent.tmp-");
        if ours && e.path().is_file() && fs::remove_file(e.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
#[path = "data_root_move_tests.rs"]
mod data_root_move_tests;
