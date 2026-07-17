//! M6-B2B — the tenant trust root: private key file + public record.
//!
//! ## What a trust root is for
//!
//! M6-B2A answered "who may run a writing server" with an install id: a device is primary
//! because someone said so, and the DB records *which* installation. That binding is
//! local — it convinces this machine, nothing else. A trust root is the next level: a
//! tenant-wide Ed25519 keypair whose private half signs **authority certificates**
//! (M6-B2C), so a claim can be checked by anyone holding only the public key.
//!
//! ## The separation that does the work
//!
//! - private key → `sync_tenant_root.key`, app data dir of the primary, never in SQLite
//! - public key + fingerprint → `tenant_trust_roots` in the server DB
//!
//! Copy the server DB and you get every public record and **no ability to sign anything**.
//! That is the same trick as `install_id.rs`, one level up: the install id proves *which
//! machine*, the root key proves *which tenant authority*.
//!
//! ## Deliberately NOT here
//!
//! No rotation mechanism, no client re-enrolment, no cross-signing. `rotated` /
//! `compromised` / `lost` exist as *states* so the model can express reality, but this
//! slice only ever creates the first `active` root and reads it back. Acting on the other
//! states is M6-B2D/E.

use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use zeroize::Zeroize;

/// Private root key file, beside `sync_install_id.key` and `sync_jwt_secret.key`.
const ROOT_KEY_FILENAME: &str = "sync_tenant_root.key";

/// M6-B2C4 §6 — an imported root that is NOT yet allowed to sign.
///
/// A transferred root arrives on the target before the source has committed. If it landed
/// straight on `ROOT_KEY_FILENAME`, the target would hold a loadable signing key while the
/// source still legitimately holds one, and the only thing standing between that and two
/// live signers would be a DB check somebody remembered to write. So the pending key lives
/// under a name the normal loader does not know, and only `activate` renames it.
const PENDING_KEY_PREFIX: &str = "sync_tenant_root.pending.";
const PENDING_KEY_SUFFIX: &str = ".key";

/// Self-describing prefix. A truncated or foreign file fails on this before we ever try
/// to interpret bytes as a key.
const ROOT_KEY_PREFIX: &str = "LATAIF-TENANT-ROOT-V1:";

/// Ed25519 seed length.
const SEED_LEN: usize = 32;

// ── Error codes (stable, surfaced to callers) ───────────────────────────────
pub const ERR_ROOT_KEY_ALREADY_EXISTS: &str = "ROOT_KEY_ALREADY_EXISTS";
pub const ERR_ROOT_KEY_FILE_INVALID: &str = "ROOT_KEY_FILE_INVALID";
pub const ERR_ROOT_KEY_MISSING: &str = "ROOT_KEY_RECOVERY_REQUIRED";
pub const ERR_ROOT_NOT_PRIMARY: &str = "TRUST_ROOT_REQUIRES_PRIMARY";
/// A root existed and is over (lost / compromised / revoked). The tenant cannot continue
/// it; re-enrolling the clients under a new root is B2D/B2E.
pub const ERR_TRUST_REENROLLMENT_REQUIRED: &str = "TRUST_REENROLLMENT_REQUIRED";
/// Same fact, reported where a *signing* key was needed and none can ever be produced.
pub const ERR_ROOT_LOST_REENROLLMENT: &str = "ROOT_KEY_LOST_REENROLLMENT_REQUIRED";
pub const ERR_ROOT_KEY_MISMATCH: &str = "ROOT_KEY_FILE_INVALID";

/// Lifecycle of a trust root. Only `Active` is ever written by this slice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootState {
    Active,
    Rotated,
    Revoked,
    /// Private key gone, no usable backup. The tenant cannot continue this root.
    Lost,
    Compromised,
}

impl RootState {
    pub fn as_str(self) -> &'static str {
        match self {
            RootState::Active => "active",
            RootState::Rotated => "rotated",
            RootState::Revoked => "revoked",
            RootState::Lost => "lost",
            RootState::Compromised => "compromised",
        }
    }
    pub fn parse(s: &str) -> Option<RootState> {
        match s {
            "active" => Some(RootState::Active),
            "rotated" => Some(RootState::Rotated),
            "revoked" => Some(RootState::Revoked),
            "lost" => Some(RootState::Lost),
            "compromised" => Some(RootState::Compromised),
            _ => None,
        }
    }
    /// Only an active root may sign. A rotated/revoked/lost/compromised root is history.
    pub fn may_sign(self) -> bool {
        matches!(self, RootState::Active)
    }
}

/// The public record of a trust root, as stored in the server DB.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustRootRecord {
    pub tenant_id: String,
    pub root_key_id: String,
    pub public_key: String,
    pub fingerprint: String,
    pub generation: i64,
    pub state: RootState,
}

/// A loaded private root key. Zeroizes its seed on drop — a root key in a core file or a
/// freed page is the one leak that ends the whole trust chain.
pub struct RootKey {
    seed: [u8; SEED_LEN],
    root_key_id: String,
}

impl Drop for RootKey {
    fn drop(&mut self) {
        self.seed.zeroize();
    }
}

impl std::fmt::Debug for RootKey {
    /// Never print the seed. `Debug` on a key type is exactly how secrets reach logs.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RootKey({}, seed=<redacted>)", redact(self.root_key_id()))
    }
}

impl RootKey {
    pub fn root_key_id(&self) -> &str {
        &self.root_key_id
    }

    fn signing_key(&self) -> ed25519_dalek::SigningKey {
        ed25519_dalek::SigningKey::from_bytes(&self.seed)
    }

    /// Base64 of the 32-byte Ed25519 public key.
    pub fn public_key_b64(&self) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .encode(self.signing_key().verifying_key().to_bytes())
    }

    pub fn fingerprint(&self) -> String {
        fingerprint_of(&self.signing_key().verifying_key().to_bytes())
    }

    /// Sign canonical bytes. Used by M6-B2C for authority certificates.
    pub fn sign(&self, message: &[u8]) -> Vec<u8> {
        use ed25519_dalek::Signer;
        self.signing_key().sign(message).to_bytes().to_vec()
    }

    /// The raw seed — ONLY for the encrypted recovery bundle. Deliberately
    /// `pub(crate)`: no command handler or route can reach it.
    pub(crate) fn seed(&self) -> &[u8; SEED_LEN] {
        &self.seed
    }

    pub(crate) fn from_seed(seed: [u8; SEED_LEN], root_key_id: String) -> RootKey {
        RootKey { seed, root_key_id }
    }
}

/// SHA-256 over the public key bytes, hex. Stable, comparable, safe to display.
pub fn fingerprint_of(public_key: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(public_key);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Short, log-safe rendering. Never log a full id or fingerprint verbatim.
pub fn redact(value: &str) -> String {
    let head: String = value.chars().take(8).collect();
    format!("{head}…")
}

/// Verify an Ed25519 signature against a base64 public key.
pub fn verify_signature(public_key_b64: &str, message: &[u8], signature: &[u8]) -> bool {
    use base64::Engine;
    use ed25519_dalek::Verifier;

    let Ok(pk_bytes) = base64::engine::general_purpose::STANDARD.decode(public_key_b64) else {
        return false;
    };
    let Ok(pk_arr): Result<[u8; 32], _> = pk_bytes.try_into() else {
        return false;
    };
    let Ok(vk) = ed25519_dalek::VerifyingKey::from_bytes(&pk_arr) else {
        return false;
    };
    let Ok(sig_arr): Result<[u8; 64], _> = signature.try_into() else {
        return false;
    };
    vk.verify(message, &ed25519_dalek::Signature::from_bytes(&sig_arr)).is_ok()
}

// ── Key file ────────────────────────────────────────────────────────────────

fn key_path(app_data_dir: &Path) -> std::path::PathBuf {
    app_data_dir.join(ROOT_KEY_FILENAME)
}

pub fn key_file_exists(app_data_dir: &Path) -> bool {
    key_path(app_data_dir).exists()
}

/// Parse the file contents. Fail-closed on anything unexpected — see the module note on
/// why this never self-heals.
fn parse_key_file(raw: &str) -> Result<[u8; SEED_LEN], &'static str> {
    use base64::Engine;

    let t = raw.trim();
    if t.is_empty() {
        return Err(ERR_ROOT_KEY_FILE_INVALID);
    }
    let Some(b64) = t.strip_prefix(ROOT_KEY_PREFIX) else {
        return Err(ERR_ROOT_KEY_FILE_INVALID);
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|_| ERR_ROOT_KEY_FILE_INVALID)?;
    let arr: [u8; SEED_LEN] = bytes.try_into().map_err(|_| ERR_ROOT_KEY_FILE_INVALID)?;
    // An all-zero seed is what a zeroed/sparse file decodes into. It is a *valid* Ed25519
    // seed mathematically, which is exactly why it must be rejected explicitly: it would
    // give every damaged install the same "identity".
    if arr.iter().all(|b| *b == 0) {
        return Err(ERR_ROOT_KEY_FILE_INVALID);
    }
    Ok(arr)
}

/// Load the private root key belonging to `record`.
///
/// Also checks that the file actually matches the DB's public record — a root key file
/// from a *different* tenant would otherwise silently sign certificates that no client
/// can verify.
pub fn load_key(
    app_data_dir: &Path,
    record: &TrustRootRecord,
) -> Result<RootKey, &'static str> {
    let raw = match std::fs::read_to_string(key_path(app_data_dir)) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(ERR_ROOT_KEY_MISSING),
        Err(_) => return Err(ERR_ROOT_KEY_FILE_INVALID),
    };
    let seed = parse_key_file(&raw)?;
    let key = RootKey::from_seed(seed, record.root_key_id.clone());
    if key.public_key_b64() != record.public_key || key.fingerprint() != record.fingerprint {
        return Err(ERR_ROOT_KEY_MISMATCH);
    }
    Ok(key)
}

/// Write the key file exactly once. Race-free via `create_new(true)` (atomic O_EXCL):
/// the loser of a concurrent create gets `AlreadyExists` and never clobbers the winner.
fn write_key_file(app_data_dir: &Path, seed: &[u8; SEED_LEN]) -> Result<(), &'static str> {
    use base64::Engine;
    use std::io::Write;

    let path = key_path(app_data_dir);
    let mut body = format!(
        "{ROOT_KEY_PREFIX}{}",
        base64::engine::general_purpose::STANDARD.encode(seed)
    );

    let result = (|| -> Result<(), &'static str> {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    ERR_ROOT_KEY_ALREADY_EXISTS
                } else {
                    ERR_ROOT_KEY_FILE_INVALID
                }
            })?;
        f.write_all(body.as_bytes()).map_err(|_| ERR_ROOT_KEY_FILE_INVALID)?;
        f.sync_all().map_err(|_| ERR_ROOT_KEY_FILE_INVALID)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    })();

    // The base64 body held the seed in plaintext; do not leave it in a freed String.
    body.zeroize();
    result
}

// ── M6-B2C4 §6/§7 — the pending root of a transfer target ───────────────────

fn pending_path(app_data_dir: &Path, transfer_id: &str) -> std::path::PathBuf {
    app_data_dir.join(format!("{PENDING_KEY_PREFIX}{transfer_id}{PENDING_KEY_SUFFIX}"))
}

/// Test-only. Production never asks "is there a pending key?" — it asks the DB whether
/// custody permits signing, and `load_pending_seed` fails closed if the file is not there.
/// A production caller branching on this would be re-deriving custody from the filesystem,
/// which is the exact mistake §9 exists to prevent.
#[cfg(test)]
pub fn pending_key_exists(app_data_dir: &Path, transfer_id: &str) -> bool {
    pending_path(app_data_dir, transfer_id).exists()
}

/// Write the pending key. Idempotent for an identical re-import (§8 T2), fail-closed on a
/// contradicting one.
///
/// The publication is tmp + `hard_link`, the same shape as the pushed `install_id.rs` fix
/// (`3f56d73`): `create_new` on the final path is atomic for the NAME, but it publishes
/// that name *before* `write_all` runs, so a concurrent reader can see an empty file at a
/// path that is supposed to hold a key. Writing to a temp name and hard-linking it into
/// place publishes the finished content instead. `rename` would not do — it silently
/// overwrites, and overwriting a root key is the one thing this must never do.
pub(crate) fn write_pending_key(
    app_data_dir: &Path,
    transfer_id: &str,
    seed: &[u8; SEED_LEN],
) -> Result<(), &'static str> {
    use base64::Engine;
    use std::io::Write;

    let path = pending_path(app_data_dir, transfer_id);

    // An identical re-import is a no-op; a different seed under the same transfer id is a
    // contradiction we refuse rather than resolve.
    if path.exists() {
        let raw = std::fs::read_to_string(&path).map_err(|_| ERR_ROOT_KEY_FILE_INVALID)?;
        let existing = parse_key_file(&raw)?;
        return if &existing == seed { Ok(()) } else { Err(ERR_ROOT_KEY_ALREADY_EXISTS) };
    }

    let mut body = format!(
        "{ROOT_KEY_PREFIX}{}",
        base64::engine::general_purpose::STANDARD.encode(seed)
    );
    let tmp = app_data_dir.join(format!(
        ".{PENDING_KEY_PREFIX}{transfer_id}.{}.tmp",
        uuid::Uuid::new_v4().as_simple()
    ));

    let result = (|| -> Result<(), &'static str> {
        {
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp)
                .map_err(|_| ERR_ROOT_KEY_FILE_INVALID)?;
            f.write_all(body.as_bytes()).map_err(|_| ERR_ROOT_KEY_FILE_INVALID)?;
            f.sync_all().map_err(|_| ERR_ROOT_KEY_FILE_INVALID)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
            }
        }
        match std::fs::hard_link(&tmp, &path) {
            Ok(()) => Ok(()),
            // Someone won the race. Re-read and apply the same rule as above.
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let raw = std::fs::read_to_string(&path).map_err(|_| ERR_ROOT_KEY_FILE_INVALID)?;
                let existing = parse_key_file(&raw)?;
                if &existing == seed {
                    Ok(())
                } else {
                    Err(ERR_ROOT_KEY_ALREADY_EXISTS)
                }
            }
            Err(_) => Err(ERR_ROOT_KEY_FILE_INVALID),
        }
    })();

    let _ = std::fs::remove_file(&tmp);
    body.zeroize();
    result
}

/// Read back a pending key. `pub(crate)` — only the transfer module may see a raw seed.
pub(crate) fn load_pending_seed(
    app_data_dir: &Path,
    transfer_id: &str,
) -> Result<[u8; SEED_LEN], &'static str> {
    let raw = match std::fs::read_to_string(pending_path(app_data_dir, transfer_id)) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(ERR_ROOT_KEY_MISSING),
        Err(_) => return Err(ERR_ROOT_KEY_FILE_INVALID),
    };
    parse_key_file(&raw)
}

/// The result of publishing a pending key as THE active root key (§8 T7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishOutcome {
    /// The active key file did not exist and now holds the pending seed.
    Published,
    /// It already held exactly this seed — a retried activation after a crash between
    /// file publication and DB commit. Not an error: it is the resume path.
    AlreadyIdentical,
}

/// Publish the pending key as the active root key.
///
/// Ordering, and why it is this way round (§8 T7): the file goes first, the DB second. The
/// reverse would produce a window where the DB says `target_active` — so every signing gate
/// says yes — while the key file does not exist yet. Failing that way means an authority
/// that cannot sign and a DB that insists it can. This way round, the crash window holds a
/// key file that nothing will load, because custody is still `target_pending` and the gate
/// refuses. Harmless, and the retry finds the identical file and finishes the DB half.
pub(crate) fn publish_pending_as_active(
    app_data_dir: &Path,
    transfer_id: &str,
    expect_seed: &[u8; SEED_LEN],
) -> Result<PublishOutcome, &'static str> {
    let active = key_path(app_data_dir);
    let pending = pending_path(app_data_dir, transfer_id);

    if active.exists() {
        // NEVER overwrite. If it holds the same seed we are resuming; anything else is a
        // real root key belonging to something else, and clobbering it destroys an
        // authority that cannot be reconstructed.
        let raw = std::fs::read_to_string(&active).map_err(|_| ERR_ROOT_KEY_FILE_INVALID)?;
        let existing = parse_key_file(&raw)?;
        return if &existing == expect_seed {
            Ok(PublishOutcome::AlreadyIdentical)
        } else {
            Err(ERR_ROOT_KEY_ALREADY_EXISTS)
        };
    }
    if !pending.exists() {
        return Err(ERR_ROOT_KEY_MISSING);
    }

    match std::fs::hard_link(&pending, &active) {
        Ok(()) => Ok(PublishOutcome::Published),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let raw = std::fs::read_to_string(&active).map_err(|_| ERR_ROOT_KEY_FILE_INVALID)?;
            let existing = parse_key_file(&raw)?;
            if &existing == expect_seed {
                Ok(PublishOutcome::AlreadyIdentical)
            } else {
                Err(ERR_ROOT_KEY_ALREADY_EXISTS)
            }
        }
        Err(_) => Err(ERR_ROOT_KEY_FILE_INVALID),
    }
}

/// Best-effort removal of a pending key (after activation, or on abort).
///
/// Deliberately best-effort and deliberately narrow: it only ever touches the
/// `pending.<transfer_id>` name. Never the active key — a failed transfer must not be able
/// to delete the root the tenant is actually using.
pub(crate) fn discard_pending_key(app_data_dir: &Path, transfer_id: &str) {
    let _ = std::fs::remove_file(pending_path(app_data_dir, transfer_id));
}

// ── DB records ──────────────────────────────────────────────────────────────

/// The single active root for a tenant, if any.
pub fn load_active_root(
    conn: &Connection,
    tenant_id: &str,
) -> rusqlite::Result<Option<TrustRootRecord>> {
    conn.query_row(
        "SELECT tenant_id, root_key_id, public_key, fingerprint, generation, state
           FROM tenant_trust_roots
          WHERE tenant_id = ?1 AND state = 'active'",
        params![tenant_id],
        |r| {
            let state: String = r.get(5)?;
            Ok(TrustRootRecord {
                tenant_id: r.get(0)?,
                root_key_id: r.get(1)?,
                public_key: r.get(2)?,
                fingerprint: r.get(3)?,
                generation: r.get(4)?,
                state: RootState::parse(&state).unwrap_or(RootState::Revoked),
            })
        },
    )
    .optional()
}

/// Any root for a tenant, active or not — used to refuse a *second* root.
pub fn any_root_exists(conn: &Connection, tenant_id: &str) -> rusqlite::Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tenant_trust_roots WHERE tenant_id = ?1",
        params![tenant_id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

fn insert_root(
    conn: &Connection,
    rec: &TrustRootRecord,
    created_by: &str,
) -> rusqlite::Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO tenant_trust_roots
           (tenant_id, root_key_id, public_key, fingerprint, generation, state,
            created_at, activated_at, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)",
        params![
            rec.tenant_id,
            rec.root_key_id,
            rec.public_key,
            rec.fingerprint,
            rec.generation,
            rec.state.as_str(),
            now,
            created_by,
        ],
    )?;
    Ok(())
}

// ── Initialization ──────────────────────────────────────────────────────────

/// The tenant's trust situation on THIS machine — the six recovery cases of §8, reduced
/// to the five outcomes they actually produce.
///
/// | § | situation                              | outcome                |
/// |---|---------------------------------------|------------------------|
/// | A | key file + DB record                   | `Ready`                |
/// | B | both rescued together                  | `Ready`                |
/// | C | primary lost, valid bundle             | `RecoveryRequired` → import → `Ready` |
/// | D | primary lost, no bundle                | `ReenrollmentRequired` |
/// | E | root possibly compromised              | `ReenrollmentRequired` |
/// | F | bundle present, password lost          | `ReenrollmentRequired` (D in disguise) |
///
/// D, E and F collapse into one outcome because they are one fact: **there is no usable
/// private root key.** No amount of surviving public record changes that — which is why
/// this slice never auto-activates a replacement root for them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustState {
    /// No root at all. A primary owner may initialize one.
    None,
    /// Record + matching private key. Can sign.
    Ready,
    /// The record survives but the private key does not. A valid bundle can still fix it.
    RecoveryRequired,
    /// The key file is present but unusable. Fail-closed: never overwritten automatically.
    KeyFileInvalid,
    /// This trust root cannot continue. Re-enrolment (B2D/B2E) is the only way forward.
    ReenrollmentRequired,
}

impl TrustState {
    pub fn as_str(self) -> &'static str {
        match self {
            TrustState::None => "none",
            TrustState::Ready => "ready",
            TrustState::RecoveryRequired => "recovery_required",
            TrustState::KeyFileInvalid => "key_file_invalid",
            TrustState::ReenrollmentRequired => "reenrollment_required",
        }
    }
    /// The single question M6-B2C asks before issuing a certificate.
    pub fn may_sign(self) -> bool {
        matches!(self, TrustState::Ready)
    }
}

/// Resolve the trust situation. Read-only: it never creates, repairs or deletes anything.
pub fn resolve_trust_state(conn: &Connection, app_data_dir: &Path, tenant_id: &str) -> TrustState {
    let active = match load_active_root(conn, tenant_id) {
        Ok(a) => a,
        Err(_) => return TrustState::ReenrollmentRequired,
    };

    let Some(rec) = active else {
        // No ACTIVE root. Is that because there is none at all (fresh tenant), or because
        // the only one we had is lost/compromised/revoked? The difference decides between
        // "you may set one up" and "this root is over".
        return match any_root_exists(conn, tenant_id) {
            Ok(false) => TrustState::None,
            Ok(true) => TrustState::ReenrollmentRequired,
            Err(_) => TrustState::ReenrollmentRequired,
        };
    };

    match load_key(app_data_dir, &rec) {
        Ok(_) => TrustState::Ready,
        // Case C: the record is intact, the key is simply gone → a bundle can restore it.
        Err(ERR_ROOT_KEY_MISSING) => TrustState::RecoveryRequired,
        // Damaged or foreign key file → fail-closed, and NOT silently replaced.
        Err(_) => TrustState::KeyFileInvalid,
    }
}

/// The root + private key, or the precise reason there will never be one.
///
/// Every signing caller goes through here, so "why can't I sign?" is answered in exactly
/// one place — and answered with the code that tells the owner what to actually do:
/// restore a bundle, repair the file, or re-enrol.
pub fn require_signing_root(
    conn: &Connection,
    app_data_dir: &Path,
    tenant_id: &str,
) -> Result<(TrustRootRecord, RootKey), &'static str> {
    match resolve_trust_state(conn, app_data_dir, tenant_id) {
        TrustState::None => return Err(ERR_ROOT_KEY_MISSING),
        // The root is gone for good — no bundle will bring it back.
        TrustState::ReenrollmentRequired => return Err(ERR_ROOT_LOST_REENROLLMENT),
        TrustState::RecoveryRequired => return Err(ERR_ROOT_KEY_MISSING),
        TrustState::KeyFileInvalid => return Err(ERR_ROOT_KEY_FILE_INVALID),
        TrustState::Ready => {}
    }
    let rec = load_active_root(conn, tenant_id)
        .map_err(|_| ERR_ROOT_KEY_FILE_INVALID)?
        .ok_or(ERR_ROOT_KEY_MISSING)?;
    let key = load_key(app_data_dir, &rec)?;
    Ok((rec, key))
}

/// Create the tenant's FIRST trust root: private key file + public DB record.
///
/// Callers must have established, in Rust, that:
/// - this installation is `primary` with a matching instance binding, and
/// - the owner is verified (`OwnerAuth`).
///
/// Both are passed as evidence rather than re-derived here, so this stays a pure
/// key/DB operation — but the signature makes them impossible to forget.
///
/// Refuses if either the DB already knows a root or the key file already exists. Those
/// two are checked independently on purpose: a half-state (file without record, or record
/// without file) must not be papered over by overwriting the survivor.
pub fn initialize_root(
    conn: &Connection,
    app_data_dir: &Path,
    tenant_id: &str,
    install_id: &str,
    primary_state: super::primary::State,
    owner: &super::primary::OwnerAuth,
) -> Result<TrustRootRecord, &'static str> {
    // K4 — only a real, instance-matched primary owns a tenant root. A client,
    // unconfigured, legacy_pending or read_only device creating one would mint a second
    // authority root for the same tenant out of thin air.
    if !primary_state.may_write_sync() {
        return Err(ERR_ROOT_NOT_PRIMARY);
    }
    if any_root_exists(conn, tenant_id).map_err(|_| ERR_ROOT_KEY_FILE_INVALID)? {
        // Distinguish the two "no" answers, because they mean opposite things to the
        // owner. An ACTIVE root: "you already have one, nothing to do." A dead one
        // (lost/compromised/revoked): "this root is over" — and quietly minting a
        // replacement here would silently orphan every client still trusting the old
        // public key. That needs re-enrolment, which is B2D/B2E.
        let active = load_active_root(conn, tenant_id).map_err(|_| ERR_ROOT_KEY_FILE_INVALID)?;
        return Err(if active.is_some() {
            ERR_ROOT_KEY_ALREADY_EXISTS
        } else {
            ERR_TRUST_REENROLLMENT_REQUIRED
        });
    }
    if key_file_exists(app_data_dir) {
        return Err(ERR_ROOT_KEY_ALREADY_EXISTS);
    }

    let mut seed = [0u8; SEED_LEN];
    {
        use rand::RngCore;
        // OS CSPRNG. `try_fill_bytes` so an entropy failure is an error, never a
        // silently weak key.
        rand::rngs::OsRng
            .try_fill_bytes(&mut seed)
            .map_err(|_| ERR_ROOT_KEY_FILE_INVALID)?;
    }

    let root_key_id = uuid::Uuid::new_v4().to_string();
    let key = RootKey::from_seed(seed, root_key_id.clone());
    let rec = TrustRootRecord {
        tenant_id: tenant_id.to_string(),
        root_key_id,
        public_key: key.public_key_b64(),
        fingerprint: key.fingerprint(),
        generation: 1,
        state: RootState::Active,
    };

    // File first: if the DB insert fails we would rather have an orphan file (detected,
    // and refused as ALREADY_EXISTS) than a DB record whose private key never existed —
    // the latter looks like a working root and can never sign.
    write_key_file(app_data_dir, key.seed())?;
    if let Err(e) = insert_root(conn, &rec, owner.user_id()) {
        let _ = std::fs::remove_file(key_path(app_data_dir));
        eprintln!("[trust] root insert failed, rolled back key file: {e}");
        return Err(ERR_ROOT_KEY_FILE_INVALID);
    }
    // M6-B2C4 §9 — the founding custody. The signing gate is fail-closed on custody, so a
    // root without a custody row is a root that cannot sign. Creating the root and recording
    // who holds it is one act, not two, and splitting them across call sites is how the
    // second half gets forgotten.
    if let Err(e) = super::transfer::record_founding_custody(conn, &rec, install_id) {
        let _ = std::fs::remove_file(key_path(app_data_dir));
        let _ = conn.execute(
            "DELETE FROM tenant_trust_roots WHERE tenant_id = ?1 AND root_key_id = ?2",
            params![rec.tenant_id, rec.root_key_id],
        );
        eprintln!("[trust] custody insert failed, rolled back root: {e}");
        return Err(ERR_ROOT_KEY_FILE_INVALID);
    }
    Ok(rec)
}

/// Restore a root from a verified recovery bundle (M6-B2B, case C).
///
/// Separate from `initialize_root` because the semantics differ: this does not *create*
/// an authority, it re-establishes a known one. The caller must already have decrypted
/// and verified the bundle.
pub fn restore_root(
    conn: &Connection,
    app_data_dir: &Path,
    rec: &TrustRootRecord,
    seed: [u8; SEED_LEN],
    install_id: &str,
    owner: &super::primary::OwnerAuth,
) -> Result<(), &'static str> {
    // K12/K13 — an identical re-import is a no-op; a contradicting one is refused.
    if let Ok(Some(existing)) = load_active_root(conn, &rec.tenant_id) {
        if existing.root_key_id != rec.root_key_id || existing.public_key != rec.public_key {
            return Err(ERR_ROOT_KEY_ALREADY_EXISTS);
        }
        // Same root already recorded. Only write the file if it is missing (DB rescued,
        // key file lost — recovery case B).
        if key_file_exists(app_data_dir) {
            let key = RootKey::from_seed(seed, rec.root_key_id.clone());
            return if key.public_key_b64() == existing.public_key {
                Ok(())
            } else {
                Err(ERR_ROOT_KEY_ALREADY_EXISTS)
            };
        }
        let key = RootKey::from_seed(seed, rec.root_key_id.clone());
        write_key_file(app_data_dir, key.seed())?;
        // The DB survived, so a custody row may exist for the machine that died. This
        // machine still needs its own: recovery re-establishes the root HERE.
        return super::transfer::record_founding_custody(conn, rec, install_id)
            .map_err(|_| ERR_ROOT_KEY_FILE_INVALID);
    }

    if any_root_exists(conn, &rec.tenant_id).map_err(|_| ERR_ROOT_KEY_FILE_INVALID)? {
        return Err(ERR_ROOT_KEY_ALREADY_EXISTS);
    }
    if key_file_exists(app_data_dir) {
        return Err(ERR_ROOT_KEY_ALREADY_EXISTS);
    }

    let key = RootKey::from_seed(seed, rec.root_key_id.clone());
    write_key_file(app_data_dir, key.seed())?;
    if let Err(e) = insert_root(conn, rec, owner.user_id()) {
        let _ = std::fs::remove_file(key_path(app_data_dir));
        eprintln!("[trust] root restore failed, rolled back key file: {e}");
        return Err(ERR_ROOT_KEY_FILE_INVALID);
    }
    super::transfer::record_founding_custody(conn, rec, install_id)
        .map_err(|_| ERR_ROOT_KEY_FILE_INVALID)?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod testkit {
    use super::*;

    /// A temp dir that cleans itself up on drop — including on panic.
    ///
    /// Not a nicety. These directories hold real Ed25519 tenant root keys, and cleanup
    /// written at the END of a test body simply does not run when an assertion fails. A
    /// red test would then leave private key material in the system temp dir, which is
    /// exactly the residue §20 forbids. `Drop` runs during unwinding; a trailing
    /// statement does not.
    pub struct TempDir(std::path::PathBuf);

    impl std::ops::Deref for TempDir {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    pub fn tmp_dir() -> TempDir {
        let d = std::env::temp_dir().join(format!(
            "com.lataif.m6b2bctest20260717-{}",
            uuid::Uuid::new_v4().as_simple()
        ));
        std::fs::create_dir_all(&d).unwrap();
        TempDir(d)
    }

    pub fn key_file_path(dir: &Path) -> std::path::PathBuf {
        key_path(dir)
    }

    pub fn parse_file(raw: &str) -> Result<[u8; SEED_LEN], &'static str> {
        parse_key_file(raw)
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::*;
    use super::*;
    use crate::sync::primary::{self, State};

    /// The install id these tests found their root under. Fixed, not random: M6-B2C4
    /// records custody per install, and a value that changed between calls would leave the
    /// custody row pointing at a machine the next call is not.
    const TEST_INSTALL: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
                plan TEXT, active INTEGER, max_branches INTEGER, max_users INTEGER,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
                name TEXT NOT NULL, country TEXT, currency TEXT, address TEXT, active INTEGER,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
                email TEXT NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL, active INTEGER,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(tenant_id, email));
             CREATE TABLE user_branches (user_id TEXT NOT NULL REFERENCES users(id),
                branch_id TEXT NOT NULL REFERENCES branches(id), role TEXT NOT NULL,
                is_default INTEGER, created_at TEXT NOT NULL, PRIMARY KEY (user_id, branch_id));
             CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
                branch_id TEXT NOT NULL, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
                action TEXT NOT NULL, data TEXT NOT NULL, user_id TEXT, created_at TEXT NOT NULL);
             INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES ('tenant-1','T','t','n','n');
             INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES ('tenant-2','U','u','n','n');
             INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','B','n','n');",
        )
        .unwrap();
        lataif_server::migrations::run_migrations(&conn, super::super::migrations::EMBEDDED_MIGRATIONS)
            .unwrap();
        conn
    }

    /// A verified owner. `OwnerAuth` has a private field, so tests must go through the
    /// real `authorize_owner` — the same door production uses.
    fn owner(conn: &Connection) -> primary::OwnerAuth {
        let hash = bcrypt::hash("owner-pw", 4).unwrap();
        conn.execute(
            "INSERT INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at)
             VALUES ('user-owner','tenant-1','owner@x.com',?1,'O',1,'n','n')",
            params![hash],
        )
        .unwrap();
        conn.execute_batch("INSERT INTO user_branches VALUES ('user-owner','branch-main','owner',1,'n');")
            .unwrap();
        // M6-B2A4 — this owner stands for a server whose password was already provisioned.
        // Without an `active` credential row `authorize_owner` refuses at the provisioning
        // gate, and every test below would fail for a reason it is not about. The
        // "unprovisioned ⇒ refused" behaviour itself is proven in `credentials.rs`.
        conn.execute_batch(
            "INSERT INTO server_credentials
               (user_id, credential_state, password_changed_at, created_at, updated_at)
             VALUES ('user-owner','active','n','n','n');",
        )
        .unwrap();
        primary::authorize_owner(conn, "tenant-1", "branch-main", "owner@x.com", "owner-pw").unwrap()
    }

    // ── K1: root key created exactly once, valid, recorded ───────────────────
    #[test]
    fn k1_root_key_is_created_once_and_recorded() {
        let conn = db();
        let o = owner(&conn);
        let d = tmp_dir();

        let rec = initialize_root(&conn, &d, "tenant-1", TEST_INSTALL, State::Primary, &o).unwrap();
        assert_eq!(rec.generation, 1);
        assert_eq!(rec.state, RootState::Active);
        assert!(rec.state.may_sign());

        // File exists and holds a usable key that matches the public record.
        assert!(key_file_exists(&d));
        let key = load_key(&d, &rec).unwrap();
        assert_eq!(key.public_key_b64(), rec.public_key);
        assert_eq!(key.fingerprint(), rec.fingerprint);
        // Ed25519 public keys are 32 bytes; the fingerprint is a SHA-256 hex digest.
        use base64::Engine;
        assert_eq!(
            base64::engine::general_purpose::STANDARD.decode(&rec.public_key).unwrap().len(),
            32
        );
        assert_eq!(rec.fingerprint.len(), 64);

        // and it really signs
        let sig = key.sign(b"hello");
        assert!(verify_signature(&rec.public_key, b"hello", &sig));
        assert!(!verify_signature(&rec.public_key, b"hell0", &sig), "tampered message");

    }

    // ── K1b: two installations get different roots (CSPRNG, not derived) ─────
    #[test]
    fn k1b_two_roots_are_independent() {
        let (c1, c2) = (db(), db());
        let (o1, o2) = (owner(&c1), owner(&c2));
        let (d1, d2) = (tmp_dir(), tmp_dir());
        let a = initialize_root(&c1, &d1, "tenant-1", TEST_INSTALL, State::Primary, &o1).unwrap();
        let b = initialize_root(&c2, &d2, "tenant-1", TEST_INSTALL, State::Primary, &o2).unwrap();
        assert_ne!(a.public_key, b.public_key, "keys must be random, never derived");
        assert_ne!(a.root_key_id, b.root_key_id);
    }

    // ── K2: a second initialization is refused ───────────────────────────────
    #[test]
    fn k2_second_initialization_is_refused() {
        let conn = db();
        let o = owner(&conn);
        let d = tmp_dir();
        let first = initialize_root(&conn, &d, "tenant-1", TEST_INSTALL, State::Primary, &o).unwrap();

        let err = initialize_root(&conn, &d, "tenant-1", TEST_INSTALL, State::Primary, &o).unwrap_err();
        assert_eq!(err, ERR_ROOT_KEY_ALREADY_EXISTS);

        // The original survives, untouched.
        let still = load_active_root(&conn, "tenant-1").unwrap().unwrap();
        assert_eq!(still, first);
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM tenant_trust_roots", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "no second root row");
    }

    // ── K2b: the DB itself forbids a second active root ──────────────────────
    #[test]
    fn k2b_schema_forbids_two_active_roots() {
        let conn = db();
        let o = owner(&conn);
        let d = tmp_dir();
        initialize_root(&conn, &d, "tenant-1", TEST_INSTALL, State::Primary, &o).unwrap();
        let second = TrustRootRecord {
            tenant_id: "tenant-1".into(),
            root_key_id: uuid::Uuid::new_v4().to_string(),
            public_key: "AAAA".into(),
            fingerprint: "ffff".into(),
            generation: 2,
            state: RootState::Active,
        };
        assert!(
            insert_root(&conn, &second, "user-owner").is_err(),
            "unique partial index must forbid a second ACTIVE root"
        );
    }

    // ── K3: empty / invalid key file is fail-closed and never replaced ───────
    #[test]
    fn k3_invalid_key_file_fails_closed_and_is_not_replaced() {
        let conn = db();
        let o = owner(&conn);
        let d = tmp_dir();
        let rec = initialize_root(&conn, &d, "tenant-1", TEST_INSTALL, State::Primary, &o).unwrap();
        let p = key_file_path(&d);

        for bad in [
            "".to_string(),
            "   \n".to_string(),
            "garbage".to_string(),
            // right prefix, wrong length
            format!("{ROOT_KEY_PREFIX}AAAA"),
            // right prefix + right length, but all-zero seed
            format!(
                "{ROOT_KEY_PREFIX}{}",
                {
                    use base64::Engine;
                    base64::engine::general_purpose::STANDARD.encode([0u8; 32])
                }
            ),
            // valid base64 of 32 bytes but no prefix
            {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD.encode([7u8; 32])
            },
        ] {
            std::fs::write(&p, &bad).unwrap();
            let err = load_key(&d, &rec).unwrap_err();
            assert_eq!(err, ERR_ROOT_KEY_FILE_INVALID, "input {bad:?} must fail closed");
            assert_eq!(
                std::fs::read_to_string(&p).unwrap(),
                bad,
                "the damaged file must NEVER be silently regenerated"
            );
        }
    }

    // ── K3b: a key file from a foreign root is rejected, not used ────────────
    #[test]
    fn k3b_foreign_key_file_is_rejected() {
        let (c1, c2) = (db(), db());
        let (o1, o2) = (owner(&c1), owner(&c2));
        let (d1, d2) = (tmp_dir(), tmp_dir());
        let rec1 = initialize_root(&c1, &d1, "tenant-1", TEST_INSTALL, State::Primary, &o1).unwrap();
        initialize_root(&c2, &d2, "tenant-1", TEST_INSTALL, State::Primary, &o2).unwrap();

        // Someone drops the OTHER install's key file next to this DB record.
        std::fs::copy(key_file_path(&d2), key_file_path(&d1)).unwrap();
        assert_eq!(
            load_key(&d1, &rec1).unwrap_err(),
            ERR_ROOT_KEY_MISMATCH,
            "a key that does not match the public record must not be used"
        );
    }

    // ── K3c: missing file → recovery required, not regeneration ──────────────
    #[test]
    fn k3c_missing_key_file_requires_recovery() {
        let conn = db();
        let o = owner(&conn);
        let d = tmp_dir();
        let rec = initialize_root(&conn, &d, "tenant-1", TEST_INSTALL, State::Primary, &o).unwrap();
        std::fs::remove_file(key_file_path(&d)).unwrap();
        assert_eq!(load_key(&d, &rec).unwrap_err(), ERR_ROOT_KEY_MISSING);
        assert!(!key_file_exists(&d), "must NOT invent a replacement key");
    }

    // ── K4: only a matched primary may create a root ─────────────────────────
    #[test]
    fn k4_non_primary_cannot_create_a_root() {
        for state in [
            State::Client,
            State::Unconfigured,
            State::ReadOnly,
            State::LegacyAdoptionRequired,
        ] {
            let conn = db();
            let o = owner(&conn);
            let d = tmp_dir();
            let err = initialize_root(&conn, &d, "tenant-1", TEST_INSTALL, state, &o).unwrap_err();
            assert_eq!(err, ERR_ROOT_NOT_PRIMARY, "{state:?} must not mint a tenant root");
            assert!(!key_file_exists(&d), "{state:?}: no key file written");
            assert!(
                !any_root_exists(&conn, "tenant-1").unwrap(),
                "{state:?}: no DB record written"
            );
        }
    }

    // ── K14: the seed never appears in Debug / errors ────────────────────────
    #[test]
    fn k14_key_material_never_leaks_into_text() {
        use base64::Engine;
        let conn = db();
        let o = owner(&conn);
        let d = tmp_dir();
        let rec = initialize_root(&conn, &d, "tenant-1", TEST_INSTALL, State::Primary, &o).unwrap();
        let key = load_key(&d, &rec).unwrap();

        let seed_b64 = base64::engine::general_purpose::STANDARD.encode(key.seed());
        let seed_hex: String = key.seed().iter().map(|b| format!("{b:02x}")).collect();

        let dbg = format!("{key:?}");
        assert!(!dbg.contains(&seed_b64), "Debug must not leak the seed");
        assert!(!dbg.contains(&seed_hex));
        assert!(dbg.contains("redacted"));

        // The redacted id is short and is not the id itself.
        let r = redact(&rec.root_key_id);
        assert!(r.len() < rec.root_key_id.len());
        assert!(!r.contains(&rec.root_key_id));

        // The public key and fingerprint are NOT secret — assert we did not confuse them
        // with the seed (a fingerprint that equalled the seed would be a real bug).
        assert_ne!(rec.fingerprint, seed_hex);
        assert_ne!(rec.public_key, seed_b64);
    }

    // ── K15: nothing here ever touches the production app data dir ───────────
    #[test]
    fn k15_tests_never_use_production_appdata() {
        let d = tmp_dir();
        let s = d.to_string_lossy().to_lowercase();
        assert!(s.contains("com.lataif.m6b2bctest20260717"), "isolated identifier");
        assert!(!s.contains("roaming\\com.lataif.app"), "never the production dir");
        assert!(!s.contains("roaming/com.lataif.app"));
    }

    // ── §8 recovery cases A–F ────────────────────────────────────────────────
    #[test]
    fn recovery_cases_a_to_f_map_to_the_declared_states() {
        // no root at all → may set one up
        {
            let conn = db();
            let d = tmp_dir();
            assert_eq!(resolve_trust_state(&conn, &d, "tenant-1"), TrustState::None);
        }
        // A / B — key file + record present
        {
            let conn = db();
            let o = owner(&conn);
            let d = tmp_dir();
            initialize_root(&conn, &d, "tenant-1", TEST_INSTALL, State::Primary, &o).unwrap();
            let st = resolve_trust_state(&conn, &d, "tenant-1");
            assert_eq!(st, TrustState::Ready, "A/B: root usable");
            assert!(st.may_sign());
        }
        // C — record survived, private key did not → a bundle can still fix this
        {
            let conn = db();
            let o = owner(&conn);
            let d = tmp_dir();
            initialize_root(&conn, &d, "tenant-1", TEST_INSTALL, State::Primary, &o).unwrap();
            std::fs::remove_file(key_file_path(&d)).unwrap();
            let st = resolve_trust_state(&conn, &d, "tenant-1");
            assert_eq!(st, TrustState::RecoveryRequired, "C: import a bundle");
            assert!(!st.may_sign(), "must not sign without the private key");
        }
        // damaged key file → fail-closed, never auto-replaced
        {
            let conn = db();
            let o = owner(&conn);
            let d = tmp_dir();
            initialize_root(&conn, &d, "tenant-1", TEST_INSTALL, State::Primary, &o).unwrap();
            std::fs::write(key_file_path(&d), "corrupted").unwrap();
            assert_eq!(resolve_trust_state(&conn, &d, "tenant-1"), TrustState::KeyFileInvalid);
            assert_eq!(
                std::fs::read_to_string(key_file_path(&d)).unwrap(),
                "corrupted",
                "resolve must be read-only — no silent repair"
            );
        }
        // D / E / F — the root is over: no active root, but one existed
        for terminal in [RootState::Lost, RootState::Compromised, RootState::Revoked] {
            let conn = db();
            let o = owner(&conn);
            let d = tmp_dir();
            initialize_root(&conn, &d, "tenant-1", TEST_INSTALL, State::Primary, &o).unwrap();
            conn.execute(
                "UPDATE tenant_trust_roots SET state = ?1, revoked_at = 'n' WHERE tenant_id = 'tenant-1'",
                params![terminal.as_str()],
            )
            .unwrap();
            let st = resolve_trust_state(&conn, &d, "tenant-1");
            assert_eq!(
                st,
                TrustState::ReenrollmentRequired,
                "{terminal:?}: no old private root key ⇒ no continuation of the same root"
            );
            assert!(!st.may_sign());
        }
    }

    // ── D/E/F: this slice never auto-activates a replacement root ────────────
    #[test]
    fn a_lost_root_is_never_silently_replaced() {
        let conn = db();
        let o = owner(&conn);
        let d = tmp_dir();
        let first = initialize_root(&conn, &d, "tenant-1", TEST_INSTALL, State::Primary, &o).unwrap();
        conn.execute(
            "UPDATE tenant_trust_roots SET state = 'lost' WHERE tenant_id = 'tenant-1'",
            [],
        )
        .unwrap();
        std::fs::remove_file(key_file_path(&d)).unwrap();

        // Even a verified owner on a real primary cannot just make a new one here — and
        // the code says WHY: the root is over, which needs re-enrolment, not a fresh key
        // quietly minted behind every client's back.
        assert_eq!(
            initialize_root(&conn, &d, "tenant-1", TEST_INSTALL, State::Primary, &o).unwrap_err(),
            ERR_TRUST_REENROLLMENT_REQUIRED,
            "re-enrolment is B2D/B2E, not an implicit side effect of initialize"
        );
        // …and the signing path reports the same fact in its own terms.
        assert_eq!(
            require_signing_root(&conn, &d, "tenant-1").unwrap_err(),
            ERR_ROOT_LOST_REENROLLMENT
        );
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM tenant_trust_roots", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        let row: String = conn
            .query_row("SELECT state FROM tenant_trust_roots WHERE root_key_id = ?1",
                params![first.root_key_id], |r| r.get(0))
            .unwrap();
        assert_eq!(row, "lost", "the historical record stays honest");
    }

    // ── parse contract ───────────────────────────────────────────────────────
    #[test]
    fn parse_accepts_only_the_declared_format() {
        use base64::Engine;
        let seed = [3u8; 32];
        let good = format!(
            "{ROOT_KEY_PREFIX}{}",
            base64::engine::general_purpose::STANDARD.encode(seed)
        );
        assert_eq!(parse_file(&format!("  {good}\n")).unwrap(), seed, "trims");
        assert!(parse_file("LATAIF-TENANT-ROOT-V2:AAAA").is_err(), "unknown version");
    }

    #[test]
    fn root_state_roundtrips_and_only_active_signs() {
        for s in [
            RootState::Active,
            RootState::Rotated,
            RootState::Revoked,
            RootState::Lost,
            RootState::Compromised,
        ] {
            assert_eq!(RootState::parse(s.as_str()), Some(s));
            assert_eq!(s.may_sign(), s == RootState::Active);
        }
        assert_eq!(RootState::parse("authority"), None);
    }
}
