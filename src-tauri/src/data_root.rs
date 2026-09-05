// ════════════════════════════════════════════════════════════════════════════
// DATA-ROOT-I1 / B1 — the ONE place that decides where LATAIF's data lives.
//
// Before this module there were three independent answers to "where is the data?": the renderer's
// `appDataDir()`, the Rust setup's `app.path().app_data_dir()`, and the server's
// `db_path.parent()`. Three answers cannot be moved together, and a directory that only exists by
// coincidence cannot be relocated at all. This module makes the answer explicit and singular.
//
// ## The two files
//
//   • LOCATOR  `<identifier-AppData>/data-location.json` — outside the data root, because a file
//     inside the root could never tell us where the root is. Identifier-scoped, so the production
//     build and the E2E build (`com.lataif.app` vs `com.lataif.app.e2e`) can never see each
//     other's locator: the isolation is structural, not a convention.
//   • MARKER   `<data root>/.lataif-data-root.json` — inside the root, carrying the SAME `rootId`.
//
// Neither file alone is authoritative. The pair is: the locator says which directory, the marker
// proves the directory is that one and not a stale copy, a restored folder or a re-created empty
// shell. A mismatch is never repaired silently — it fails closed.
//
// ## Why a missing locator is NOT a fallback
//
// The tempting rule is "no locator ⇒ use AppData". It is also the split-brain bug: after a later
// move to `E:\LATAIF\Data`, a lost locator would send the app straight back to the old `C:` root,
// which still holds a complete, openable, months-old database. The user would see their data —
// just the wrong data — and start writing into it. So the AppData fallback exists for exactly ONE
// event in the lifetime of an install: the first start after upgrading, when no locator has ever
// existed. From the moment the pair is written, a missing locator is an error, not a hint.
//
// The one exception is a bootstrap that was interrupted, and it is made recognisable rather than
// guessed at: the marker is written with `bootstrapPending: true` FIRST, the locator second, the
// final marker third. A pending marker without a locator can only mean "we crashed mid-bootstrap
// in this very directory" — never "a move happened" — so completing it is safe. A FINAL marker
// without a locator is the dangerous case and stops the app.
//
// ## What this module never does
//
// It never creates a data root that was not either (a) an existing dataset it adopted in place, or
// (b) a genuinely first-ever start. It never opens a database. It never moves a byte. Directory
// creation happens only in the bootstrap branch, after the decision, never as a side effect of
// validating a path that turned out to be wrong.
// ════════════════════════════════════════════════════════════════════════════

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The locator, in the identifier-scoped AppData directory.
pub const LOCATOR_FILENAME: &str = "data-location.json";
/// The marker, in the data root itself.
pub const MARKER_FILENAME: &str = ".lataif-data-root.json";
pub const LOCATOR_SCHEMA_VERSION: u32 = 1;
pub const MARKER_SCHEMA_VERSION: u32 = 1;

// ── the names of everything that lives UNDER a data root ────────────────────
// These were literals in ~40 places. One list, one truth.
pub const BUSINESS_DB_FILENAME: &str = "lataif.db";
pub const SYNC_SERVER_DB_FILENAME: &str = "lataif_sync_server.db";
pub const MEDIA_DIRNAME: &str = "media";
pub const MOBILE_STAGING_DIRNAME: &str = "mobile-upload-staging";
/// CENTRAL-C3C — die neutrale Zwischenablage der Fernauftraege. BEWUSST nicht dasselbe
/// Verzeichnis wie `mobile-upload-staging`: dort liegen Bilder, die zu einer Inbox-Zeile und damit
/// zu einem entstehenden Produkt gehoeren. Hier liegen Bytes, die noch gar nichts sind.
pub const COMMAND_STAGING_DIRNAME: &str = "command-staging";
pub const OPENAI_KEY_FILENAME: &str = "openai.key";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DataRootError {
    /// The locator exists but is not readable/parsable JSON.
    LocatorCorrupt,
    /// The locator's schema version is newer/unknown — a downgrade must not guess.
    LocatorSchemaUnsupported,
    /// `dataRoot` is empty or not an absolute path.
    LocatorPathNotAbsolute,
    /// The locator is gone although this install was already registered (a FINAL marker exists).
    LocatorMissingAfterRegistration,
    /// The configured root is not reachable right now (drive absent, folder removed, not a dir).
    RootUnreachable,
    /// The root is reachable but carries no marker.
    MarkerMissing,
    /// The marker exists but is not readable/parsable JSON, or its schema is unknown.
    MarkerCorrupt,
    /// Locator and marker name different roots.
    RootIdMismatch,
    /// The root was adopted WITH a business database, and that database is now gone.
    BusinessDbMissing,
    /// DATA-ROOT-B1 — nothing is registered here yet, and nobody has said what that means.
    ///
    /// An empty control directory has two possible histories, and from `C:` alone they look the
    /// same: a genuinely first start, or a machine that was reinstalled while the data lives on
    /// another drive. Adopting the empty directory would answer that question by itself — and it
    /// used to: the resolver bootstrapped a fresh root here, with a fresh `rootId` and an empty
    /// database, which is exactly the wrong answer for the second history and cannot be taken back.
    /// So the resolver stops and hands the question to the person who knows: set up a new
    /// installation, or recover an existing data location.
    FirstRunUndecided,
    Io(String),
}

impl DataRootError {
    pub fn code(&self) -> &'static str {
        match self {
            DataRootError::LocatorCorrupt => "DATA_ROOT_LOCATOR_CORRUPT",
            DataRootError::LocatorSchemaUnsupported => "DATA_ROOT_LOCATOR_SCHEMA_UNSUPPORTED",
            DataRootError::LocatorPathNotAbsolute => "DATA_ROOT_LOCATOR_PATH_NOT_ABSOLUTE",
            DataRootError::LocatorMissingAfterRegistration => "DATA_ROOT_LOCATOR_MISSING",
            DataRootError::RootUnreachable => "DATA_ROOT_UNREACHABLE",
            DataRootError::MarkerMissing => "DATA_ROOT_MARKER_MISSING",
            DataRootError::MarkerCorrupt => "DATA_ROOT_MARKER_CORRUPT",
            DataRootError::RootIdMismatch => "DATA_ROOT_ID_MISMATCH",
            DataRootError::BusinessDbMissing => "DATA_ROOT_BUSINESS_DB_MISSING",
            DataRootError::FirstRunUndecided => "DATA_ROOT_FIRST_RUN_UNDECIDED",
            DataRootError::Io(_) => "DATA_ROOT_IO",
        }
    }

    /// A sentence the owner can act on. Never leaks anything but the configured path.
    pub fn message(&self, root_hint: Option<&Path>) -> String {
        let where_ = root_hint
            .map(|p| format!(" ({})", p.display()))
            .unwrap_or_default();
        match self {
            DataRootError::LocatorMissingAfterRegistration => format!(
                "The LATAIF data location file is missing although this installation was already \
                 registered{where_}. LATAIF will not open a possibly outdated data set. Restore \
                 data-location.json or contact support."
            ),
            DataRootError::RootUnreachable => format!(
                "The configured LATAIF data location{where_} cannot be reached right now (drive \
                 disconnected or folder removed). LATAIF will not start with a different or empty \
                 data set. Reconnect the drive and start again."
            ),
            DataRootError::MarkerMissing => format!(
                "The configured LATAIF data location{where_} exists but is not a LATAIF data \
                 folder. LATAIF will not create a new, empty data set there."
            ),
            DataRootError::RootIdMismatch => format!(
                "The configured LATAIF data location{where_} belongs to a different data set than \
                 the one this installation is registered to. LATAIF will not open it."
            ),
            DataRootError::BusinessDbMissing => format!(
                "The LATAIF database is missing from the configured data location{where_}. LATAIF \
                 will not start with an empty database. Restore a backup or contact support."
            ),
            _ => format!(
                "The configured LATAIF data location{where_} cannot be opened safely ({}).",
                self.code()
            ),
        }
    }
}

fn io<E: std::fmt::Display>(ctx: &'static str) -> impl Fn(E) -> DataRootError {
    move |e| DataRootError::Io(format!("{ctx}: {e}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Locator {
    pub schema_version: u32,
    pub data_root: String,
    pub root_id: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootMarker {
    pub schema_version: u32,
    pub root_id: String,
    pub created_at: String,
    /// True only between the first and the last write of a bootstrap. See the module header.
    #[serde(default)]
    pub bootstrap_pending: bool,
    /// True when this root was adopted from an EXISTING dataset. A later boot then treats a
    /// missing business DB as an error instead of as "first start".
    #[serde(default)]
    pub business_db_expected: bool,
}

/// The resolved, validated data root. Every runtime path is derived from here and nowhere else.
#[derive(Debug, Clone)]
pub struct DataRoot {
    root: PathBuf,
    root_id: String,
    /// True when the root is the identifier-scoped AppData directory itself (legacy in place).
    legacy_in_place: bool,
}

impl DataRoot {
    pub fn path(&self) -> &Path {
        &self.root
    }
    pub fn root_id(&self) -> &str {
        &self.root_id
    }
    pub fn is_legacy_in_place(&self) -> bool {
        self.legacy_in_place
    }
    pub fn business_db(&self) -> PathBuf {
        self.root.join(BUSINESS_DB_FILENAME)
    }
    pub fn sync_server_db(&self) -> PathBuf {
        self.root.join(SYNC_SERVER_DB_FILENAME)
    }
    pub fn media_root(&self) -> PathBuf {
        self.root.join(MEDIA_DIRNAME)
    }
    pub fn mobile_staging_root(&self) -> PathBuf {
        self.root.join(MOBILE_STAGING_DIRNAME)
    }
    pub fn command_staging_root(&self) -> PathBuf {
        self.root.join(COMMAND_STAGING_DIRNAME)
    }
    pub fn openai_key(&self) -> PathBuf {
        self.root.join(OPENAI_KEY_FILENAME)
    }

    /// Test-only: a root that was never resolved from a locator. Used by the in-crate route
    /// fixtures, which need a `DataRoot` but have no AppData to bootstrap from.
    #[cfg(test)]
    pub fn for_test(root: PathBuf) -> Self {
        Self { root, root_id: "test-root".into(), legacy_in_place: false }
    }
}

// ── atomic little writes (temp → fsync → rename), same shape as the intent files ─────────────
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), DataRootError> {
    let tmp = path.with_extension(format!(
        "tmp-{}",
        uuid::Uuid::new_v4().as_simple()
    ));
    {
        let mut f = fs::File::create(&tmp).map_err(io("create tmp"))?;
        f.write_all(bytes).map_err(io("write tmp"))?;
        f.sync_all().map_err(io("sync tmp"))?;
    }
    // std::fs::rename replaces an existing destination on Windows as well as on unix.
    fs::rename(&tmp, path).map_err(io("rename into place"))?;
    Ok(())
}

pub(crate) fn read_locator(app_data_dir: &Path) -> Result<Option<Locator>, DataRootError> {
    let p = app_data_dir.join(LOCATOR_FILENAME);
    if !p.exists() {
        return Ok(None);
    }
    let raw = fs::read(&p).map_err(|_| DataRootError::LocatorCorrupt)?;
    let loc: Locator = serde_json::from_slice(&raw).map_err(|_| DataRootError::LocatorCorrupt)?;
    if loc.schema_version != LOCATOR_SCHEMA_VERSION {
        return Err(DataRootError::LocatorSchemaUnsupported);
    }
    if loc.root_id.trim().is_empty() {
        return Err(DataRootError::LocatorCorrupt);
    }
    Ok(Some(loc))
}

pub fn read_marker(root: &Path) -> Result<Option<RootMarker>, DataRootError> {
    let p = root.join(MARKER_FILENAME);
    if !p.exists() {
        return Ok(None);
    }
    let raw = fs::read(&p).map_err(|_| DataRootError::MarkerCorrupt)?;
    let m: RootMarker = serde_json::from_slice(&raw).map_err(|_| DataRootError::MarkerCorrupt)?;
    if m.schema_version != MARKER_SCHEMA_VERSION || m.root_id.trim().is_empty() {
        return Err(DataRootError::MarkerCorrupt);
    }
    Ok(Some(m))
}

pub(crate) fn write_marker(root: &Path, m: &RootMarker) -> Result<(), DataRootError> {
    let bytes = serde_json::to_vec_pretty(m).map_err(io("encode marker"))?;
    write_atomic(&root.join(MARKER_FILENAME), &bytes)
}

pub(crate) fn write_locator(app_data_dir: &Path, l: &Locator) -> Result<(), DataRootError> {
    let bytes = serde_json::to_vec_pretty(l).map_err(io("encode locator"))?;
    write_atomic(&app_data_dir.join(LOCATOR_FILENAME), &bytes)
}

pub(crate) fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Point the locator at `root` with `root_id`. The ONLY way the active root ever changes, and the
/// commit point of a move. Atomic (temp → fsync → rename).
pub fn set_locator(app_data_dir: &Path, root: &Path, root_id: &str) -> Result<(), DataRootError> {
    write_locator(
        app_data_dir,
        &Locator {
            schema_version: LOCATOR_SCHEMA_VERSION,
            data_root: root.to_string_lossy().to_string(),
            root_id: root_id.to_string(),
            updated_at: now_iso(),
        },
    )
}

/// Build a `DataRoot` for a path whose marker has ALREADY been validated against `root_id` by the
/// caller. Used by the move engine after it has proven the target; never a way around `resolve`.
pub(crate) fn validated(root: PathBuf, root_id: String, app_data_dir: &Path) -> DataRoot {
    let legacy_in_place = same_dir(&root, app_data_dir);
    DataRoot { root, root_id, legacy_in_place }
}

/// Resolve the active data root for this installation.
///
/// `app_data_dir` is the identifier-scoped AppData directory — the place the locator lives, and
/// (for every install that predates this module) the legacy data root itself.
pub fn resolve(app_data_dir: &Path) -> Result<DataRoot, DataRootError> {
    match read_locator(app_data_dir)? {
        Some(loc) => resolve_from_locator(app_data_dir, loc),
        None => resolve_without_locator(app_data_dir),
    }
}

fn resolve_from_locator(app_data_dir: &Path, loc: Locator) -> Result<DataRoot, DataRootError> {
    let root = PathBuf::from(loc.data_root.trim());
    if loc.data_root.trim().is_empty() || !root.is_absolute() {
        return Err(DataRootError::LocatorPathNotAbsolute);
    }
    // Reachability BEFORE anything else, and without creating anything: an absent drive must look
    // like "come back later", never like "empty root".
    if !root.is_dir() {
        return Err(DataRootError::RootUnreachable);
    }
    let marker = read_marker(&root)?.ok_or(DataRootError::MarkerMissing)?;
    if marker.root_id != loc.root_id {
        return Err(DataRootError::RootIdMismatch);
    }
    // A bootstrap that got as far as the locator: finish it, same id, no data touched.
    if marker.bootstrap_pending {
        write_marker(&root, &RootMarker { bootstrap_pending: false, ..marker.clone() })?;
    }
    if marker.business_db_expected && !root.join(BUSINESS_DB_FILENAME).exists() {
        return Err(DataRootError::BusinessDbMissing);
    }
    let legacy_in_place = same_dir(&root, app_data_dir);
    Ok(DataRoot { root, root_id: loc.root_id, legacy_in_place })
}

fn resolve_without_locator(app_data_dir: &Path) -> Result<DataRoot, DataRootError> {
    // The locator is gone. Whether that is allowed depends entirely on the marker in the legacy
    // directory — see the module header.
    match read_marker(app_data_dir)? {
        // A FINAL marker without a locator: this install was registered and the locator was lost.
        // Adopting the folder again is exactly the split-brain we refuse to risk.
        Some(m) if !m.bootstrap_pending => Err(DataRootError::LocatorMissingAfterRegistration),
        // An interrupted bootstrap in this very directory — safe to complete, same id.
        Some(m) => finish_bootstrap(app_data_dir, m),
        // No marker at all. Two very different situations look the same from here, and the
        // difference is whether there is DATA in this directory:
        //
        //   • A legacy install upgrading to the locator contract: `lataif.db` is right here, and
        //     adopting the folder in place is the only correct answer — it is the data.
        //   • A control directory with nothing in it: that is either a genuinely first start or a
        //     machine that was reinstalled while the data sits on another drive. Bootstrapping
        //     would answer that question by itself, with a fresh id and an empty database, and it
        //     could not be taken back. So it is handed to the person who knows.
        None if app_data_dir.join(BUSINESS_DB_FILENAME).exists() => bootstrap(app_data_dir),
        // DATA-ROOT-B1 — `resolve` keeps bootstrapping here for now, because the window that would
        // ask the question does not exist yet; switching this line before there is a gate would
        // turn a first start into a dead end. The decision itself is already implemented and proven
        // one level up, in `resolve_or_first_run`, and that is what the gate will call.
        None => bootstrap(app_data_dir),
    }
}

/// What a start finds before anything has been decided.
///
/// DATA-ROOT-B1 — noch ruft niemand das hier auf: die Weiche, die die Frage stellt, wird als
/// naechstes gebaut. Bis dahin ist der Vertrag hier implementiert und bewiesen, aber nicht aktiv —
/// `resolve` verhaelt sich unveraendert, damit ein Erststart nicht in eine Sackgasse laeuft.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub enum Resolution {
    /// A root this installation is registered with — the normal case.
    Root(DataRoot),
    /// Nothing is registered here and there is no data either. Nobody may answer this but a person.
    FirstRunUndecided,
}

/// Resolve the active data root, or report that the question is still open.
///
/// The difference to `resolve` is one directory: an EMPTY control directory. `resolve` adopts it —
/// it has to, because every caller today expects a root back. This entry point does not: it looks,
/// finds nothing, writes nothing, and says so. A machine that was reinstalled while its data sits
/// on another drive gets a question instead of a fresh empty installation it can never take back.
///
/// Everything else is the resolver's own contract, unchanged: a valid pair resolves, a lost locator
/// after registration fails closed, a legacy folder WITH a database is still adopted in place.
#[allow(dead_code)]
pub fn resolve_or_first_run(app_data_dir: &Path) -> Result<Resolution, DataRootError> {
    if read_locator(app_data_dir)?.is_none()
        && read_marker(app_data_dir)?.is_none()
        && !app_data_dir.join(BUSINESS_DB_FILENAME).exists()
    {
        return Ok(Resolution::FirstRunUndecided);
    }
    resolve(app_data_dir).map(Resolution::Root)
}

/// Set up a NEW installation in `app_data_dir` — the deliberate answer to `FirstRunUndecided`.
///
/// This is the bootstrap the resolver used to run by itself. It is unchanged in what it does: a new
/// `rootId`, the marker/locator pair written in the safe order, nothing moved, copied or opened.
/// What changed is who asks for it — a person, once, instead of a start that found an empty folder.
pub fn setup_new_installation(app_data_dir: &Path) -> Result<DataRoot, DataRootError> {
    // Never over an existing registration: if anything is already here, the normal resolver owns
    // this directory and this call has no business writing a second identity into it.
    if read_locator(app_data_dir)?.is_some() || read_marker(app_data_dir)?.is_some() {
        return resolve(app_data_dir);
    }
    bootstrap(app_data_dir)
}

/// First start after the upgrade (or the very first start ever): adopt `app_data_dir` in place.
/// NOTHING is moved, copied or created beyond the two small files.
fn bootstrap(app_data_dir: &Path) -> Result<DataRoot, DataRootError> {
    fs::create_dir_all(app_data_dir).map_err(io("create app data dir"))?;
    let marker = RootMarker {
        schema_version: MARKER_SCHEMA_VERSION,
        root_id: uuid::Uuid::new_v4().to_string(),
        created_at: now_iso(),
        bootstrap_pending: true,
        business_db_expected: app_data_dir.join(BUSINESS_DB_FILENAME).exists(),
    };
    // 1) pending marker, 2) locator (the commit point), 3) final marker.
    write_marker(app_data_dir, &marker)?;
    finish_bootstrap(app_data_dir, marker)
}

fn finish_bootstrap(app_data_dir: &Path, marker: RootMarker) -> Result<DataRoot, DataRootError> {
    let root_id = marker.root_id.clone();
    write_locator(
        app_data_dir,
        &Locator {
            schema_version: LOCATOR_SCHEMA_VERSION,
            data_root: app_data_dir.to_string_lossy().to_string(),
            root_id: root_id.clone(),
            updated_at: now_iso(),
        },
    )?;
    write_marker(app_data_dir, &RootMarker { bootstrap_pending: false, ..marker })?;
    Ok(DataRoot { root: app_data_dir.to_path_buf(), root_id, legacy_in_place: true })
}

// ── path overlap — shared by the backup-location validator and (later) the move ──────────────
//
// Two roots overlap when they are the same directory or one contains the other. Comparing strings
// is not enough on Windows: `E:\LATAIF` and `e:\lataif\` and `E:\LATAIF\..\LATAIF` are one place,
// while `E:\LATAIF` and `E:\LATAIFX` are two. Canonicalisation answers all of that correctly
// (`\\?\E:\lataif` on both sides, and `Path::starts_with` compares whole components, so the
// LATAIFX case is not a prefix match).

fn canonical(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

fn same_dir(a: &Path, b: &Path) -> bool {
    canonical(a) == canonical(b)
}

/// True when `a` and `b` are the same directory, or either contains the other.
/// Both paths should exist; a path that cannot be canonicalised is compared as given (fail-safe:
/// an unresolvable path is more likely to be reported as overlapping than as separate).
pub fn paths_overlap(a: &Path, b: &Path) -> bool {
    let ca = canonical(a);
    let cb = canonical(b);
    ca == cb || ca.starts_with(&cb) || cb.starts_with(&ca)
}

#[cfg(test)]
#[path = "data_root_tests.rs"]
mod data_root_tests;
