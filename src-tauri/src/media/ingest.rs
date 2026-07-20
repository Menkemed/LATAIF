//! MEDIA-04A-2A — guarded media ingest service + durable file journal.
//!
//! This is the thin, testable layer between the (thin) Tauri command wrappers
//! and the proven no-clobber image core (`super::storage` / `super::normalize`).
//! It owns a durable, crash-recoverable **file journal** so that prepared and
//! published image files can be unambiguously recognised and cleaned up after a
//! crash or restart. It writes **no** SQL.js metadata and knows **no** product
//! id — that is MEDIA-04A-2B/04A-3.
//!
//! The journal lives under `<media_root>/.ingest-journal/`, one entry per
//! `(tenant_scope, ingest_request_id)`. Journal files never contain image bytes
//! or user file paths, only content hashes, sizes and derived storage keys.

use super::storage;
use super::{create_thumbnail, normalize_stock_image, Limits, MediaDescriptor, MediaError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

const PROTO_VERSION: &str = "media-ingest-v1";
const JOURNAL_VERSION: u32 = 1;
/// Normalization parameters that are part of the canonical request identity.
const NORM_PARAMS: &str = "main<=100000;thumb<=20000;out=jpeg";
const JOURNAL_DIR_NAME: &str = ".ingest-journal";
/// Ceiling for reading a staged temp file back into memory during commit/recovery.
const MAX_TEMP_BYTES: u64 = 100_000;
/// Hard rendition byte budgets — the semantic-validation guard refuses any journal
/// claiming a byte size above these.
const MAX_MAIN_BYTES: usize = 100_000;
const MAX_THUMB_BYTES: usize = 20_000;
/// Hard IPC-layer input ceiling. A raw upload exceeding this is refused before
/// image decoding or any journal write. Chosen well above realistic camera JPEGs
/// but far below anything that could stall the decoder or exhaust memory.
pub const MAX_INGEST_INPUT_BYTES: usize = 25 * 1024 * 1024;

// ── errors ───────────────────────────────────────────────────────────────────

/// Stable, safe error surface for the ingest layer. Core errors pass through
/// unchanged via [`IngestError::Core`]. No variant carries a path.
#[derive(Debug, Clone, PartialEq)]
pub enum IngestError {
    /// A request-hash / request-id combination is inconsistent.
    RequestConflict,
    /// No journal exists for the requested identity.
    NotFound,
    /// The journal is in a state that forbids the requested transition.
    InvalidState,
    /// A published request may not be physically deleted.
    AlreadyPublished,
    /// The on-disk journal could not be parsed or its identity/shape fields do
    /// not match the addressed slot.
    JournalCorrupt,
    /// A staged temp file that must exist is missing.
    TempMissing,
    /// The request is quarantined and must be resolved out of band.
    Quarantined,
    /// A malformed scope / request-id / request-hash input.
    InvalidRequest,
    /// The raw input exceeds the fixed IPC-layer input ceiling.
    InputTooLarge,
    /// An error from the image/storage core, passed through unchanged.
    Core(MediaError),
    /// Filesystem error (kind only, never a path).
    Io(String),
}

impl IngestError {
    pub fn code(&self) -> &'static str {
        match self {
            IngestError::RequestConflict => "MEDIA_INGEST_REQUEST_CONFLICT",
            IngestError::NotFound => "MEDIA_INGEST_NOT_FOUND",
            IngestError::InvalidState => "MEDIA_INGEST_INVALID_STATE",
            IngestError::AlreadyPublished => "MEDIA_INGEST_ALREADY_PUBLISHED",
            IngestError::JournalCorrupt => "MEDIA_INGEST_JOURNAL_CORRUPT",
            IngestError::TempMissing => "MEDIA_INGEST_TEMP_MISSING",
            IngestError::Quarantined => "MEDIA_INGEST_QUARANTINED",
            IngestError::InvalidRequest => "MEDIA_INGEST_INVALID_REQUEST",
            IngestError::InputTooLarge => "MEDIA_INGEST_INPUT_TOO_LARGE",
            IngestError::Core(e) => e.code(),
            IngestError::Io(_) => "MEDIA_IO_ERROR",
        }
    }
}

impl From<MediaError> for IngestError {
    fn from(e: MediaError) -> Self {
        IngestError::Core(e)
    }
}

fn io_err(e: &std::io::Error) -> IngestError {
    IngestError::Io(format!("io:{:?}", e.kind()))
}

// ── DTOs ─────────────────────────────────────────────────────────────────────

/// A rendition descriptor without the bytes (safe to persist / return to JS).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredDescriptor {
    pub hash: String,
    pub extension: String,
    pub content_kind: String,
    pub mime_type: String,
    pub byte_size: usize,
    pub width: u32,
    pub height: u32,
}

impl From<&MediaDescriptor> for StoredDescriptor {
    fn from(d: &MediaDescriptor) -> Self {
        StoredDescriptor {
            hash: d.hash.clone(),
            extension: d.extension.clone(),
            content_kind: d.content_kind.clone(),
            mime_type: d.mime_type.clone(),
            byte_size: d.byte_size,
            width: d.width,
            height: d.height,
        }
    }
}

/// Journal state machine. Forward-only; the allowed transitions are enforced in
/// code, never taken from a caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IngestState {
    Preparing,
    Prepared,
    Publishing,
    Published,
    Aborted,
    CleanupPending,
    Quarantined,
}

/// The durable journal entry. Serialized as JSON. No image bytes, no user paths.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestJournal {
    pub journal_version: u32,
    pub tenant_scope: String,
    pub ingest_request_id: String,
    pub request_hash: String,
    pub state: IngestState,
    pub created_at: String,
    pub updated_at: String,
    pub main_descriptor: Option<StoredDescriptor>,
    pub thumbnail_descriptor: Option<StoredDescriptor>,
    pub main_temp_key: Option<String>,
    pub thumbnail_temp_key: Option<String>,
    pub main_storage_key: Option<String>,
    pub thumbnail_storage_key: Option<String>,
    pub last_error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrepareResult {
    pub ingest_request_id: String,
    pub request_hash: String,
    pub state: IngestState,
    pub main_descriptor: StoredDescriptor,
    pub thumbnail_descriptor: StoredDescriptor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitResult {
    pub state: IngestState,
    pub main_descriptor: StoredDescriptor,
    pub thumbnail_descriptor: StoredDescriptor,
    pub main_storage_key: String,
    pub thumbnail_storage_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AbortResult {
    pub ingest_request_id: String,
    pub state: IngestState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryOutcome {
    pub tenant_scope: String,
    pub ingest_request_id: String,
    pub from_state: IngestState,
    pub to_state: IngestState,
    pub action: String,
}

/// Verified bytes plus controlled metadata (no path) for `read_verified_media`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaBytes {
    pub bytes: Vec<u8>,
    pub hash: String,
    pub byte_size: usize,
    pub mime_type: String,
    pub extension: String,
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// UTC RFC-3339 timestamp for audit fields (not used in any decision logic).
fn now_ts() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn rand_suffix() -> String {
    format!("{:016x}", rand::random::<u64>())
}

/// A request id must be a strict, filename-safe token (covers UUIDs).
fn is_valid_request_id(id: &str) -> bool {
    (8..=80).contains(&id.len())
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn is_valid_hash64(h: &str) -> bool {
    h.len() == 64
        && h.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// The canonical, Rust-computed request hash. Binds protocol version, scope, the
/// operation, the SHA-256 of the *input* bytes and the normalization params.
fn canonical_request_hash(scope: &str, input_bytes: &[u8]) -> String {
    let input_sha = storage::sha256_hex(input_bytes);
    let material = format!("{PROTO_VERSION}|{scope}|stock_image|{input_sha}|{NORM_PARAMS}");
    storage::sha256_hex(material.as_bytes())
}

fn storage_key(scope: &str, hash: &str) -> String {
    format!("{scope}/{}/{hash}.jpg", &hash[0..2])
}

// ── service ──────────────────────────────────────────────────────────────────

/// The ingest service. Holds only the (injectable) media root plus its own
/// per-identity lock table, so it is fully testable without a running desktop
/// app.
///
/// `identity_locks` serialises every mutating operation for a given
/// `(tenant_scope, ingest_request_id)` within this process, provided that
/// every caller reaches the service through the **same** `MediaIngestService`
/// instance. The desktop app owns exactly one instance in Tauri-managed state
/// (`AppHandleState.media_ingest`); every `#[tauri::command]` handler clones
/// the same `Arc` and therefore shares this registry.
///
/// The entries are held as `Weak<Mutex<()>>` so a lock disappears from the
/// map as soon as the last operation on that identity releases it — the
/// registry cannot grow unbounded over the lifetime of the app. A subsequent
/// `identity_lock` call for the same key creates a fresh `Arc` on demand.
///
/// `write_barrier` is a test-only hook fired between the durable `sync_all`
/// and the atomic rename of a journal update — production leaves it `None`,
/// tests use it to prove the replace contract by returning early.
pub struct MediaIngestService {
    media_root: PathBuf,
    identity_locks: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    write_barrier: Mutex<Option<Arc<dyn Fn() -> Result<(), IngestError> + Send + Sync>>>,
}

/// Outcome of the no-clobber first-write for a fresh journal file. `Created`
/// means we won the create race; `Existed` means an entry already sits on disk
/// for this `(scope, id)` and the caller must reload + reconcile.
enum CreateOutcome {
    Created,
    Existed,
}

enum FinalStatus {
    Present,
    Missing,
    Bad,
}

impl MediaIngestService {
    pub fn new(media_root: PathBuf) -> Self {
        MediaIngestService {
            media_root,
            identity_locks: Mutex::new(HashMap::new()),
            write_barrier: Mutex::new(None),
        }
    }

    /// Return the identity-scoped `Arc<Mutex<()>>` for a `(scope, id)` pair,
    /// creating one on first access. The caller is expected to acquire the
    /// returned mutex to serialise its operation against every other prepare/
    /// commit/abort/recover for the same identity **on this service instance**.
    ///
    /// Entries are stored as `Weak` so the lock evaporates once the last live
    /// operation drops its `Arc`. Every call also opportunistically prunes any
    /// dead entries it observes, so the map's size stays proportional to the
    /// number of *currently in-flight* identities rather than to the total
    /// number of identities ever seen.
    fn identity_lock(&self, scope: &str, request_id: &str) -> Arc<Mutex<()>> {
        let key = Self::entry_key(scope, request_id);
        let mut map = self
            .identity_locks
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        // Prune dead entries lazily on every access — keeps the map bounded
        // without needing a background sweeper. Cheap because the map only
        // contains identities that have ever been seen since last GC.
        map.retain(|_, w| w.strong_count() > 0);
        if let Some(arc) = map.get(&key).and_then(Weak::upgrade) {
            return arc;
        }
        let arc = Arc::new(Mutex::new(()));
        map.insert(key, Arc::downgrade(&arc));
        arc
    }

    /// Number of identity locks currently held by at least one live operation.
    /// Public so command-level race tests can prove the registry shrinks back
    /// to zero after every in-flight operation finishes.
    pub fn active_identity_lock_count(&self) -> usize {
        let map = self
            .identity_locks
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        map.values().filter(|w| w.strong_count() > 0).count()
    }

    /// Install a test hook that runs between the `sync_all` of the journal
    /// scratch file and the atomic `rename` that publishes the new version.
    /// Returning an error from the hook aborts the update *without* leaving a
    /// truncated on-disk journal — the previous version stays authoritative.
    /// Public so the ingest_tests suite can drive the atomic-replace proof.
    pub fn set_journal_write_barrier(
        &self,
        hook: Option<Arc<dyn Fn() -> Result<(), IngestError> + Send + Sync>>,
    ) {
        let mut slot = self.write_barrier.lock().unwrap_or_else(|p| p.into_inner());
        *slot = hook;
    }

    fn call_write_barrier(&self) -> Result<(), IngestError> {
        let cb = {
            let slot = self.write_barrier.lock().unwrap_or_else(|p| p.into_inner());
            slot.clone()
        };
        match cb {
            Some(f) => f(),
            None => Ok(()),
        }
    }

    fn journal_dir(&self, canon_root: &Path) -> PathBuf {
        canon_root.join(JOURNAL_DIR_NAME)
    }

    fn entry_key(scope: &str, request_id: &str) -> String {
        format!("{scope}__{request_id}")
    }

    fn journal_path(&self, canon_root: &Path, scope: &str, request_id: &str) -> PathBuf {
        self.journal_dir(canon_root)
            .join(format!("{}.json", Self::entry_key(scope, request_id)))
    }

    fn temp_path(&self, canon_root: &Path, temp_key: &str) -> PathBuf {
        self.journal_dir(canon_root).join(temp_key)
    }

    fn validate(scope: &str, request_id: &str, request_hash: &str) -> Result<(), IngestError> {
        if !storage::is_valid_scope(scope)
            || !is_valid_request_id(request_id)
            || !is_valid_hash64(request_hash)
        {
            return Err(IngestError::InvalidRequest);
        }
        Ok(())
    }

    /// Durably replace an existing journal entry: temp file in the same dir,
    /// `flush + sync_all`, an optional test-only barrier hook, then an atomic
    /// rename of the target. A crash between temp-write and rename leaves the
    /// old file intact; a crash after rename leaves the new file intact — never
    /// truncated JSON either way.
    fn write_journal_durable(
        &self,
        canon_root: &Path,
        journal: &IngestJournal,
    ) -> Result<(), IngestError> {
        let dir = self.journal_dir(canon_root);
        fs::create_dir_all(&dir).map_err(|e| io_err(&e))?;
        let final_path = self.journal_path(
            canon_root,
            &journal.tenant_scope,
            &journal.ingest_request_id,
        );
        storage::assert_no_reparse_under_root(canon_root, &final_path)?;
        let json = serde_json::to_vec_pretty(journal)
            .map_err(|_| IngestError::Io("io:Serialize".to_string()))?;
        let tmp = dir.join(format!(
            ".{}.{}.journal-tmp",
            Self::entry_key(&journal.tenant_scope, &journal.ingest_request_id),
            rand_suffix()
        ));
        {
            let mut f = File::create(&tmp).map_err(|e| io_err(&e))?;
            f.write_all(&json).map_err(|e| io_err(&e))?;
            f.flush().map_err(|e| io_err(&e))?;
            f.sync_all().map_err(|e| io_err(&e))?;
        }
        // Test-only hook fires here — the temp is fully synced but not yet
        // renamed. If the hook aborts, we drop the temp and surface the error
        // so the caller can prove the previous journal survived intact.
        if let Err(e) = self.call_write_barrier() {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
        // Journal updates are replace-safe: we intend to supersede the old entry.
        fs::rename(&tmp, &final_path).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            io_err(&e)
        })?;
        let _ = File::open(&dir).and_then(|d| d.sync_all());
        Ok(())
    }

    /// No-clobber first-write for a journal file. Stages a synced temp file and
    /// then materialises the final path via `hard_link`, which returns
    /// `AlreadyExists` from the OS if the target already sits on disk — so
    /// concurrent creators cannot silently overwrite each other. `Existed`
    /// tells the caller to reload the winner and reconcile idempotently.
    fn write_journal_create_no_clobber(
        &self,
        canon_root: &Path,
        journal: &IngestJournal,
    ) -> Result<CreateOutcome, IngestError> {
        let dir = self.journal_dir(canon_root);
        fs::create_dir_all(&dir).map_err(|e| io_err(&e))?;
        let final_path = self.journal_path(
            canon_root,
            &journal.tenant_scope,
            &journal.ingest_request_id,
        );
        storage::assert_no_reparse_under_root(canon_root, &final_path)?;
        let json = serde_json::to_vec_pretty(journal)
            .map_err(|_| IngestError::Io("io:Serialize".to_string()))?;
        let tmp = dir.join(format!(
            ".{}.{}.creating",
            Self::entry_key(&journal.tenant_scope, &journal.ingest_request_id),
            rand_suffix()
        ));
        {
            let mut f = File::create(&tmp).map_err(|e| io_err(&e))?;
            f.write_all(&json).map_err(|e| io_err(&e))?;
            f.flush().map_err(|e| io_err(&e))?;
            f.sync_all().map_err(|e| io_err(&e))?;
        }
        if let Err(e) = self.call_write_barrier() {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
        // Atomic no-clobber: `hard_link` fails with `AlreadyExists` when the
        // final path exists — on POSIX because `link(2)` returns `EEXIST`, on
        // Windows because `CreateHardLinkW` returns `ERROR_ALREADY_EXISTS`.
        // Rust maps both to the same kind.
        let outcome = match fs::hard_link(&tmp, &final_path) {
            Ok(()) => CreateOutcome::Created,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => CreateOutcome::Existed,
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err(io_err(&e));
            }
        };
        let _ = fs::remove_file(&tmp);
        if matches!(outcome, CreateOutcome::Created) {
            let _ = File::open(&dir).and_then(|d| d.sync_all());
        }
        Ok(outcome)
    }

    fn load_journal(
        &self,
        canon_root: &Path,
        scope: &str,
        request_id: &str,
    ) -> Result<Option<IngestJournal>, IngestError> {
        let path = self.journal_path(canon_root, scope, request_id);
        match fs::read(&path) {
            Ok(bytes) => {
                let j: IngestJournal =
                    serde_json::from_slice(&bytes).map_err(|_| IngestError::JournalCorrupt)?;
                // Full semantic check — including path/shape validation —
                // happens before the caller ever consults any journal field,
                // so recovery cannot follow a manipulated temp/storage key.
                Self::validate_journal_semantics(&j, scope, request_id)?;
                Ok(Some(j))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(io_err(&e)),
        }
    }

    /// Enforce the on-disk journal invariants that all callers rely on. Any
    /// mismatch — a foreign tenant, a manipulated temp/storage key, an
    /// oversized rendition, a state that cannot legally hold the fields it
    /// carries — is a hard [`IngestError::JournalCorrupt`]. Keeps recovery
    /// honest: no downstream fs op ever consults an unvalidated path.
    fn validate_journal_semantics(
        j: &IngestJournal,
        scope: &str,
        request_id: &str,
    ) -> Result<(), IngestError> {
        if j.journal_version != JOURNAL_VERSION {
            return Err(IngestError::JournalCorrupt);
        }
        if j.tenant_scope != scope || j.ingest_request_id != request_id {
            return Err(IngestError::JournalCorrupt);
        }
        if !storage::is_valid_scope(&j.tenant_scope)
            || !is_valid_request_id(&j.ingest_request_id)
            || !is_valid_hash64(&j.request_hash)
        {
            return Err(IngestError::JournalCorrupt);
        }
        let expected_main_key = format!("{}.main.jpg.tmp", Self::entry_key(scope, request_id));
        let expected_thumb_key = format!("{}.thumb.jpg.tmp", Self::entry_key(scope, request_id));

        match j.state {
            IngestState::Prepared | IngestState::Publishing | IngestState::Published => {
                let main = j
                    .main_descriptor
                    .as_ref()
                    .ok_or(IngestError::JournalCorrupt)?;
                let thumb = j
                    .thumbnail_descriptor
                    .as_ref()
                    .ok_or(IngestError::JournalCorrupt)?;
                Self::validate_descriptor(main, MAX_MAIN_BYTES)?;
                Self::validate_descriptor(thumb, MAX_THUMB_BYTES)?;

                let main_key = j
                    .main_temp_key
                    .as_deref()
                    .ok_or(IngestError::JournalCorrupt)?;
                let thumb_key = j
                    .thumbnail_temp_key
                    .as_deref()
                    .ok_or(IngestError::JournalCorrupt)?;
                if main_key != expected_main_key || thumb_key != expected_thumb_key {
                    return Err(IngestError::JournalCorrupt);
                }

                let main_sk = j
                    .main_storage_key
                    .as_deref()
                    .ok_or(IngestError::JournalCorrupt)?;
                let thumb_sk = j
                    .thumbnail_storage_key
                    .as_deref()
                    .ok_or(IngestError::JournalCorrupt)?;
                if main_sk != storage_key(scope, &main.hash)
                    || thumb_sk != storage_key(scope, &thumb.hash)
                {
                    return Err(IngestError::JournalCorrupt);
                }
            }
            IngestState::Preparing => {
                // Intent-only. The temp keys are set by `prepare` immediately, but
                // no descriptors/storage keys exist yet. Reject any attempt to
                // claim a payload — that could only come from tampering.
                if j.main_descriptor.is_some()
                    || j.thumbnail_descriptor.is_some()
                    || j.main_storage_key.is_some()
                    || j.thumbnail_storage_key.is_some()
                {
                    return Err(IngestError::JournalCorrupt);
                }
                if let Some(k) = j.main_temp_key.as_deref() {
                    if k != expected_main_key {
                        return Err(IngestError::JournalCorrupt);
                    }
                }
                if let Some(k) = j.thumbnail_temp_key.as_deref() {
                    if k != expected_thumb_key {
                        return Err(IngestError::JournalCorrupt);
                    }
                }
            }
            IngestState::Aborted | IngestState::CleanupPending | IngestState::Quarantined => {
                // Terminal-abandonment states may carry residual descriptors from
                // an earlier prepared/publishing snapshot. Only enforce the shape
                // when fields are set — no field is *required* here.
                if let Some(d) = j.main_descriptor.as_ref() {
                    Self::validate_descriptor(d, MAX_MAIN_BYTES)?;
                }
                if let Some(d) = j.thumbnail_descriptor.as_ref() {
                    Self::validate_descriptor(d, MAX_THUMB_BYTES)?;
                }
                if let Some(k) = j.main_temp_key.as_deref() {
                    if k != expected_main_key {
                        return Err(IngestError::JournalCorrupt);
                    }
                }
                if let Some(k) = j.thumbnail_temp_key.as_deref() {
                    if k != expected_thumb_key {
                        return Err(IngestError::JournalCorrupt);
                    }
                }
                if let (Some(sk), Some(d)) =
                    (j.main_storage_key.as_deref(), j.main_descriptor.as_ref())
                {
                    if sk != storage_key(scope, &d.hash) {
                        return Err(IngestError::JournalCorrupt);
                    }
                }
                if let (Some(sk), Some(d)) = (
                    j.thumbnail_storage_key.as_deref(),
                    j.thumbnail_descriptor.as_ref(),
                ) {
                    if sk != storage_key(scope, &d.hash) {
                        return Err(IngestError::JournalCorrupt);
                    }
                }
            }
        }
        Ok(())
    }

    fn validate_descriptor(d: &StoredDescriptor, max_bytes: usize) -> Result<(), IngestError> {
        if !is_valid_hash64(&d.hash) {
            return Err(IngestError::JournalCorrupt);
        }
        if d.byte_size > max_bytes {
            return Err(IngestError::JournalCorrupt);
        }
        if d.extension != "jpg" || d.mime_type != "image/jpeg" {
            return Err(IngestError::JournalCorrupt);
        }
        Ok(())
    }

    /// Durably write a staged temp file (replace-safe; a re-prepare may overwrite).
    fn write_temp_durable(
        &self,
        canon_root: &Path,
        temp_key: &str,
        bytes: &[u8],
    ) -> Result<(), IngestError> {
        let dir = self.journal_dir(canon_root);
        fs::create_dir_all(&dir).map_err(|e| io_err(&e))?;
        let final_path = self.temp_path(canon_root, temp_key);
        storage::assert_no_reparse_under_root(canon_root, &final_path)?;
        let tmp = dir.join(format!(".{temp_key}.{}.writing", rand_suffix()));
        {
            let mut f = File::create(&tmp).map_err(|e| io_err(&e))?;
            f.write_all(bytes).map_err(|e| io_err(&e))?;
            f.flush().map_err(|e| io_err(&e))?;
            f.sync_all().map_err(|e| io_err(&e))?;
        }
        fs::rename(&tmp, &final_path).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            io_err(&e)
        })?;
        Ok(())
    }

    /// Read a staged temp file back, size-capped, and verify it hashes to `hash`.
    fn read_temp_verified(
        &self,
        canon_root: &Path,
        temp_key: &str,
        hash: &str,
    ) -> Result<Vec<u8>, IngestError> {
        let path = self.temp_path(canon_root, temp_key);
        let md = match fs::metadata(&path) {
            Ok(md) => md,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(IngestError::TempMissing)
            }
            Err(e) => return Err(io_err(&e)),
        };
        if md.len() > MAX_TEMP_BYTES {
            return Err(IngestError::Core(MediaError::FileTooLarge));
        }
        let bytes = fs::read(&path).map_err(|e| io_err(&e))?;
        if storage::sha256_hex(&bytes) != hash {
            return Err(IngestError::JournalCorrupt);
        }
        Ok(bytes)
    }

    fn remove_temp(&self, canon_root: &Path, temp_key: &str) -> std::io::Result<()> {
        match fs::remove_file(self.temp_path(canon_root, temp_key)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }

    // ── prepare ──────────────────────────────────────────────────────────────

    pub fn prepare(
        &self,
        scope: &str,
        request_id: &str,
        request_hash: &str,
        input_bytes: &[u8],
        _original_name: Option<&str>,
    ) -> Result<PrepareResult, IngestError> {
        Self::validate(scope, request_id, request_hash)?;
        // Refuse at the IPC boundary before any decode/hash/journal work.
        if input_bytes.len() > MAX_INGEST_INPUT_BYTES {
            return Err(IngestError::InputTooLarge);
        }
        // Rust computes the canonical request hash and refuses a client value
        // that does not match the actual request content.
        let canonical = canonical_request_hash(scope, input_bytes);
        if request_hash != canonical {
            return Err(IngestError::RequestConflict);
        }
        let canon_root = storage::ensure_root_canonical(&self.media_root)?;

        // Serialise every mutation of this identity within the process, so
        // concurrent prepare/commit/abort/recover calls line up rather than
        // racing on the on-disk journal.
        let lock = self.identity_lock(scope, request_id);
        let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());

        if let Some(j) = self.load_journal(&canon_root, scope, request_id)? {
            if j.request_hash != canonical {
                return Err(IngestError::RequestConflict);
            }
            match j.state {
                IngestState::Prepared | IngestState::Publishing | IngestState::Published => {
                    return prepare_result(&j)
                }
                // Interrupted prepare with matching hash → re-run idempotently.
                IngestState::Preparing => {}
                IngestState::Aborted | IngestState::Quarantined | IngestState::CleanupPending => {
                    return Err(IngestError::InvalidState)
                }
            }
        }

        // Record intent first with an atomic no-clobber write, then stage temp
        // files, then flip to prepared. Two writers reaching this branch at
        // once are safe: the `hard_link` primitive lets exactly one create the
        // file; the loser observes `Existed`, reloads, and idempotency-checks.
        let main_key = format!("{}.main.jpg.tmp", Self::entry_key(scope, request_id));
        let thumb_key = format!("{}.thumb.jpg.tmp", Self::entry_key(scope, request_id));
        let ts = now_ts();
        let mut journal = IngestJournal {
            journal_version: JOURNAL_VERSION,
            tenant_scope: scope.to_string(),
            ingest_request_id: request_id.to_string(),
            request_hash: canonical.clone(),
            state: IngestState::Preparing,
            created_at: ts.clone(),
            updated_at: ts,
            main_descriptor: None,
            thumbnail_descriptor: None,
            main_temp_key: Some(main_key.clone()),
            thumbnail_temp_key: Some(thumb_key.clone()),
            main_storage_key: None,
            thumbnail_storage_key: None,
            last_error_code: None,
        };
        match self.write_journal_create_no_clobber(&canon_root, &journal)? {
            CreateOutcome::Created => {}
            CreateOutcome::Existed => {
                // Another writer beat us between load and create. Reload the
                // winner: same hash → idempotent, different hash → conflict.
                let winner = self
                    .load_journal(&canon_root, scope, request_id)?
                    .ok_or(IngestError::JournalCorrupt)?;
                if winner.request_hash != canonical {
                    return Err(IngestError::RequestConflict);
                }
                match winner.state {
                    IngestState::Prepared | IngestState::Publishing | IngestState::Published => {
                        return prepare_result(&winner)
                    }
                    IngestState::Preparing => {
                        // Fall through so we finish staging on top of the
                        // existing intent — safe because both intents carry
                        // the same request hash.
                        journal = winner;
                    }
                    IngestState::Aborted
                    | IngestState::Quarantined
                    | IngestState::CleanupPending => return Err(IngestError::InvalidState),
                }
            }
        }

        // Normalize via the proven core, then stage both durable temp files.
        let main = normalize_stock_image(input_bytes, &Limits::default())?;
        let thumb = create_thumbnail(input_bytes, &Limits::default())?;
        self.write_temp_durable(&canon_root, &main_key, &main.bytes)?;
        self.write_temp_durable(&canon_root, &thumb_key, &thumb.bytes)?;

        journal.main_descriptor = Some((&main).into());
        journal.thumbnail_descriptor = Some((&thumb).into());
        journal.main_storage_key = Some(storage_key(scope, &main.hash));
        journal.thumbnail_storage_key = Some(storage_key(scope, &thumb.hash));
        journal.state = IngestState::Prepared;
        journal.updated_at = now_ts();
        self.write_journal_durable(&canon_root, &journal)?;

        prepare_result(&journal)
    }

    // ── commit ───────────────────────────────────────────────────────────────

    pub fn commit(
        &self,
        scope: &str,
        request_id: &str,
        request_hash: &str,
    ) -> Result<CommitResult, IngestError> {
        Self::validate(scope, request_id, request_hash)?;
        let canon_root = storage::ensure_root_canonical(&self.media_root)?;
        let lock = self.identity_lock(scope, request_id);
        let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut journal = self
            .load_journal(&canon_root, scope, request_id)?
            .ok_or(IngestError::NotFound)?;
        if journal.request_hash != request_hash {
            return Err(IngestError::RequestConflict);
        }
        match journal.state {
            IngestState::Published => return commit_result(&journal),
            IngestState::Prepared | IngestState::Publishing => {}
            IngestState::Preparing
            | IngestState::Aborted
            | IngestState::Quarantined
            | IngestState::CleanupPending => return Err(IngestError::InvalidState),
        }

        journal.state = IngestState::Publishing;
        journal.updated_at = now_ts();
        self.write_journal_durable(&canon_root, &journal)?;

        let main_desc = journal
            .main_descriptor
            .clone()
            .ok_or(IngestError::JournalCorrupt)?;
        let thumb_desc = journal
            .thumbnail_descriptor
            .clone()
            .ok_or(IngestError::JournalCorrupt)?;
        let main_key = journal
            .main_temp_key
            .clone()
            .ok_or(IngestError::JournalCorrupt)?;
        let thumb_key = journal
            .thumbnail_temp_key
            .clone()
            .ok_or(IngestError::JournalCorrupt)?;

        // Publish both via the no-clobber core (idempotent under retry/resume).
        self.publish_rendition(&canon_root, scope, &main_key, &main_desc.hash)?;
        self.publish_rendition(&canon_root, scope, &thumb_key, &thumb_desc.hash)?;

        // Re-verify both finals really landed with the right bytes.
        storage::read_verified_media(&self.media_root, scope, &main_desc.hash, "jpg")?;
        storage::read_verified_media(&self.media_root, scope, &thumb_desc.hash, "jpg")?;

        journal.state = IngestState::Published;
        journal.updated_at = now_ts();
        self.write_journal_durable(&canon_root, &journal)?;

        // Staging temp files are no longer needed.
        let _ = self.remove_temp(&canon_root, &main_key);
        let _ = self.remove_temp(&canon_root, &thumb_key);

        commit_result(&journal)
    }

    /// Publish one rendition from its verified staging temp, unless it is already
    /// present and correct at the content-addressed path.
    fn publish_rendition(
        &self,
        canon_root: &Path,
        scope: &str,
        temp_key: &str,
        hash: &str,
    ) -> Result<(), IngestError> {
        match storage::read_verified_media(&self.media_root, scope, hash, "jpg") {
            Ok(_) => return Ok(()), // already published and correct
            Err(MediaError::FileMissing) => {}
            Err(e) => return Err(IngestError::Core(e)), // foreign/oversized → surface
        }
        let bytes = self.read_temp_verified(canon_root, temp_key, hash)?;
        storage::publish_atomically(&self.media_root, scope, &bytes, hash, "jpg")?;
        Ok(())
    }

    // ── abort ────────────────────────────────────────────────────────────────

    pub fn abort(&self, scope: &str, request_id: &str) -> Result<AbortResult, IngestError> {
        if !storage::is_valid_scope(scope) || !is_valid_request_id(request_id) {
            return Err(IngestError::InvalidRequest);
        }
        let canon_root = storage::ensure_root_canonical(&self.media_root)?;
        let lock = self.identity_lock(scope, request_id);
        let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut journal = self
            .load_journal(&canon_root, scope, request_id)?
            .ok_or(IngestError::NotFound)?;

        match journal.state {
            IngestState::Published => return Err(IngestError::AlreadyPublished),
            IngestState::Aborted => return Ok(abort_result(&journal)),
            IngestState::Prepared | IngestState::Preparing => {}
            IngestState::Publishing | IngestState::Quarantined | IngestState::CleanupPending => {
                return Err(IngestError::InvalidState)
            }
        }

        let mut cleanup_ok = true;
        if let Some(k) = journal.main_temp_key.clone() {
            cleanup_ok &= self.remove_temp(&canon_root, &k).is_ok();
        }
        if let Some(k) = journal.thumbnail_temp_key.clone() {
            cleanup_ok &= self.remove_temp(&canon_root, &k).is_ok();
        }
        journal.state = if cleanup_ok {
            IngestState::Aborted
        } else {
            IngestState::CleanupPending
        };
        journal.updated_at = now_ts();
        self.write_journal_durable(&canon_root, &journal)?;
        Ok(abort_result(&journal))
    }

    // ── read ─────────────────────────────────────────────────────────────────

    pub fn read(&self, scope: &str, hash: &str, ext: &str) -> Result<MediaBytes, IngestError> {
        if !storage::is_valid_scope(scope) || !is_valid_hash64(hash) {
            return Err(IngestError::InvalidRequest);
        }
        let bytes = storage::read_verified_media(&self.media_root, scope, hash, ext)?;
        Ok(MediaBytes {
            byte_size: bytes.len(),
            hash: hash.to_string(),
            mime_type: "image/jpeg".to_string(),
            extension: ext.to_string(),
            bytes,
        })
    }

    // ── recovery ─────────────────────────────────────────────────────────────

    pub fn recover(&self) -> Result<Vec<RecoveryOutcome>, IngestError> {
        let canon_root = storage::ensure_root_canonical(&self.media_root)?;
        let dir = self.journal_dir(&canon_root);
        let entries = match fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(io_err(&e)),
        };
        // Snapshot candidate filenames first so the dir iterator drops before
        // we start acquiring per-identity locks (and so recover cannot see its
        // own journal writes mid-walk).
        let mut candidates: Vec<String> = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy().to_string();
            if !name.ends_with(".json") || name.starts_with('.') {
                continue;
            }
            candidates.push(name);
        }

        let mut out = Vec::new();
        for name in candidates {
            let stem = name.trim_end_matches(".json").to_string();
            let (scope, request_id) = match stem.split_once("__") {
                Some((s, i)) if !s.is_empty() && !i.is_empty() => (s.to_string(), i.to_string()),
                _ => {
                    // Foreign filename — cannot be one of ours; report as corrupt.
                    out.push(RecoveryOutcome {
                        tenant_scope: String::new(),
                        ingest_request_id: stem,
                        from_state: IngestState::Quarantined,
                        to_state: IngestState::Quarantined,
                        action: "journal_corrupt".to_string(),
                    });
                    continue;
                }
            };
            // Serialise recovery against any concurrent prepare/commit/abort
            // for the same identity, and load through the full semantic guard.
            let lock = self.identity_lock(&scope, &request_id);
            let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
            match self.load_journal(&canon_root, &scope, &request_id) {
                Ok(Some(j)) => out.push(self.recover_one(&canon_root, j)?),
                Ok(None) => continue, // vanished between listing and load
                Err(IngestError::JournalCorrupt) => {
                    out.push(RecoveryOutcome {
                        tenant_scope: scope,
                        ingest_request_id: request_id,
                        from_state: IngestState::Quarantined,
                        to_state: IngestState::Quarantined,
                        action: "journal_corrupt".to_string(),
                    });
                }
                Err(e) => return Err(e),
            }
        }
        Ok(out)
    }

    fn final_status(&self, scope: &str, desc: &Option<StoredDescriptor>) -> FinalStatus {
        let Some(d) = desc else {
            return FinalStatus::Bad;
        };
        match storage::read_verified_media(&self.media_root, scope, &d.hash, "jpg") {
            Ok(_) => FinalStatus::Present,
            Err(MediaError::FileMissing) => FinalStatus::Missing,
            // hash mismatch, oversized, reparse, io → treat as bad (quarantine).
            Err(_) => FinalStatus::Bad,
        }
    }

    fn recover_one(
        &self,
        canon_root: &Path,
        mut j: IngestJournal,
    ) -> Result<RecoveryOutcome, IngestError> {
        let from = j.state;
        let scope = j.tenant_scope.clone();
        let action: &str;

        match j.state {
            // Case A
            IngestState::Prepared => {
                let main_ok = self.temp_verified(canon_root, &j.main_temp_key, &j.main_descriptor);
                let thumb_ok =
                    self.temp_verified(canon_root, &j.thumbnail_temp_key, &j.thumbnail_descriptor);
                if main_ok && thumb_ok {
                    action = "kept_prepared";
                } else {
                    j.state = IngestState::CleanupPending;
                    j.last_error_code = Some("MEDIA_INGEST_TEMP_MISSING".to_string());
                    action = "cleanup_pending_temp_missing";
                }
            }
            IngestState::Publishing => {
                let main_status = self.final_status(&scope, &j.main_descriptor);
                let thumb_status = self.final_status(&scope, &j.thumbnail_descriptor);
                let bad = matches!(main_status, FinalStatus::Bad)
                    || matches!(thumb_status, FinalStatus::Bad);
                let both_present = matches!(main_status, FinalStatus::Present)
                    && matches!(thumb_status, FinalStatus::Present);
                if bad {
                    // Case E — a final exists with the wrong bytes: do not overwrite.
                    j.state = IngestState::Quarantined;
                    j.last_error_code = Some("MEDIA_INGEST_QUARANTINED".to_string());
                    action = "quarantined_bad_final";
                } else if both_present {
                    // Case B
                    j.state = IngestState::Published;
                    action = "repaired_published";
                } else {
                    // Case C — publish the missing rendition(s) from verified temp.
                    let mut ok = true;
                    if matches!(main_status, FinalStatus::Missing) {
                        ok &= self.recover_publish(
                            canon_root,
                            &scope,
                            &j.main_temp_key,
                            &j.main_descriptor,
                        );
                    }
                    if ok && matches!(thumb_status, FinalStatus::Missing) {
                        ok &= self.recover_publish(
                            canon_root,
                            &scope,
                            &j.thumbnail_temp_key,
                            &j.thumbnail_descriptor,
                        );
                    }
                    let now_present = matches!(
                        self.final_status(&scope, &j.main_descriptor),
                        FinalStatus::Present
                    ) && matches!(
                        self.final_status(&scope, &j.thumbnail_descriptor),
                        FinalStatus::Present
                    );
                    if ok && now_present {
                        j.state = IngestState::Published;
                        action = "repaired_published_from_temp";
                    } else {
                        // Case D — temp missing and final missing.
                        j.state = IngestState::CleanupPending;
                        j.last_error_code = Some("MEDIA_INGEST_TEMP_MISSING".to_string());
                        action = "cleanup_pending_no_temp";
                    }
                }
            }
            // Incomplete prepare is not recoverable to a good state.
            IngestState::Preparing => {
                j.state = IngestState::CleanupPending;
                action = "cleanup_pending_incomplete_prepare";
            }
            IngestState::Published => action = "already_published",
            IngestState::Aborted => action = "already_aborted",
            IngestState::Quarantined => action = "already_quarantined",
            IngestState::CleanupPending => action = "already_cleanup_pending",
        }

        if j.state != from {
            j.updated_at = now_ts();
            self.write_journal_durable(canon_root, &j)?;
        }
        Ok(RecoveryOutcome {
            tenant_scope: j.tenant_scope,
            ingest_request_id: j.ingest_request_id,
            from_state: from,
            to_state: j.state,
            action: action.to_string(),
        })
    }

    fn temp_verified(
        &self,
        canon_root: &Path,
        temp_key: &Option<String>,
        desc: &Option<StoredDescriptor>,
    ) -> bool {
        match (temp_key, desc) {
            (Some(k), Some(d)) => self.read_temp_verified(canon_root, k, &d.hash).is_ok(),
            _ => false,
        }
    }

    fn recover_publish(
        &self,
        canon_root: &Path,
        scope: &str,
        temp_key: &Option<String>,
        desc: &Option<StoredDescriptor>,
    ) -> bool {
        match (temp_key, desc) {
            (Some(k), Some(d)) => self
                .publish_rendition(canon_root, scope, k, &d.hash)
                .is_ok(),
            _ => false,
        }
    }
}

fn prepare_result(j: &IngestJournal) -> Result<PrepareResult, IngestError> {
    Ok(PrepareResult {
        ingest_request_id: j.ingest_request_id.clone(),
        request_hash: j.request_hash.clone(),
        state: j.state,
        main_descriptor: j
            .main_descriptor
            .clone()
            .ok_or(IngestError::JournalCorrupt)?,
        thumbnail_descriptor: j
            .thumbnail_descriptor
            .clone()
            .ok_or(IngestError::JournalCorrupt)?,
    })
}

fn commit_result(j: &IngestJournal) -> Result<CommitResult, IngestError> {
    Ok(CommitResult {
        state: j.state,
        main_descriptor: j
            .main_descriptor
            .clone()
            .ok_or(IngestError::JournalCorrupt)?,
        thumbnail_descriptor: j
            .thumbnail_descriptor
            .clone()
            .ok_or(IngestError::JournalCorrupt)?,
        main_storage_key: j
            .main_storage_key
            .clone()
            .ok_or(IngestError::JournalCorrupt)?,
        thumbnail_storage_key: j
            .thumbnail_storage_key
            .clone()
            .ok_or(IngestError::JournalCorrupt)?,
    })
}

fn abort_result(j: &IngestJournal) -> AbortResult {
    AbortResult {
        ingest_request_id: j.ingest_request_id.clone(),
        state: j.state,
    }
}

#[cfg(test)]
#[path = "ingest_tests.rs"]
mod ingest_tests;
