//! M6-B2D — the device's own cryptographic identity. **INACTIVE.**
//!
//! ## What is missing today, exactly
//!
//! The §2 audit answered it plainly: a client's only identity is its JWT claims —
//! `sub`/`tenant_id`/`branch_id`/`role`. That is a *user* identity and a bearer token. Two
//! machines logged in as the same user are, to the server, the same thing. `/sync/push`
//! records `user_id = claims.sub` and has no field for a device at all.
//!
//! So a device keypair is the first thing in this system that can answer "which machine is
//! this?" with a signature instead of a claim.
//!
//! ## The separation, one level below the tenant root
//!
//! ```text
//! private device key  → sync_device_identity.key       (AppData, NEVER in SQLite)
//! certificate         → sync_device_certificate.json   (AppData; a public statement)
//! public record       → enrolled_devices               (server DB)
//! ```
//!
//! Same trick as `install_id.rs` and `trust_root.rs`, third level: the install id proves
//! *which installation*, the root key proves *which tenant authority*, the device key proves
//! *which enrolled client*.
//!
//! ## The limit, stated before the code rather than after
//!
//! A **full AppData clone** — install id, device key and certificate together — is
//! indistinguishable from the original. Software cannot tell them apart without hardware
//! binding, and this module does not pretend otherwise. What it buys is that a *database*
//! copy is no longer enough, and that parallel use becomes **detectable**. Detection is not
//! prevention (§9).

use std::path::Path;
use zeroize::Zeroize;

use super::canonical::{self, CanonicalWriter};
use super::trust_root::{self, TrustRootRecord};

/// Private key file, beside `sync_install_id.key`, `sync_jwt_secret.key` and
/// `sync_tenant_root.key`.
const IDENTITY_FILENAME: &str = "sync_device_identity.key";
/// The certificate. A public document — it is kept next to the key for convenience, not for
/// secrecy.
const CERTIFICATE_FILENAME: &str = "sync_device_certificate.json";

/// Self-describing prefix. A truncated or foreign file fails here before any byte is
/// interpreted as a key.
const IDENTITY_PREFIX: &str = "LATAIF-DEVICE-IDENTITY-V1:";
const SEED_LEN: usize = 32;

pub const IDENTITY_FORMAT_VERSION: u32 = 1;
pub const CERTIFICATE_VERSION: u32 = 1;

// ── §4 — hard structural limits on everything an attacker hands us.
pub const MAX_CERTIFICATE_BYTES: usize = 16 * 1024;
pub const MAX_REQUEST_BYTES: usize = 16 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 32 * 1024;
pub const MAX_ID_LEN: usize = 64;
pub const MAX_LABEL_LEN: usize = 128;
pub const MAX_TIMESTAMP_LEN: usize = 64;
/// base64 of a 32-byte Ed25519 public key.
pub const PUBLIC_KEY_B64_LEN: usize = 44;
/// base64 of a 64-byte Ed25519 signature.
pub const SIGNATURE_B64_LEN: usize = 88;
pub const HASH_HEX_LEN: usize = 64;
pub const NONCE_B64_LEN: usize = 44;
pub const NONCE_LEN: usize = 32;
/// A device may not claim more capabilities than we have names for.
pub const MAX_CAPABILITIES: usize = 32;

// ── Error codes ─────────────────────────────────────────────────────────────
pub const ERR_IDENTITY_EXISTS: &str = "DEVICE_IDENTITY_ALREADY_EXISTS";
pub const ERR_IDENTITY_INVALID: &str = "DEVICE_IDENTITY_FILE_INVALID";
pub const ERR_IDENTITY_MISSING: &str = "DEVICE_IDENTITY_MISSING";
/// The one that matters: a certificate exists but its private key does not. This device can
/// never prove possession again — it must be re-enrolled, never silently re-keyed.
pub const ERR_REENROLLMENT_REQUIRED: &str = "DEVICE_REENROLLMENT_REQUIRED";
pub const ERR_CERT_INVALID: &str = "DEVICE_CERTIFICATE_INVALID";
pub const ERR_CERT_SIGNATURE: &str = "DEVICE_CERTIFICATE_SIGNATURE_INVALID";
pub const ERR_CERT_MISSING: &str = "DEVICE_CERTIFICATE_MISSING";
pub const ERR_DEVICE_MISMATCH: &str = "DEVICE_ID_MISMATCH";
pub const ERR_INSTALL_MISMATCH: &str = "DEVICE_INSTALL_ID_MISMATCH";
pub const ERR_KEY_MISMATCH: &str = "DEVICE_PUBLIC_KEY_MISMATCH";
pub const ERR_TENANT_MISMATCH: &str = "DEVICE_TENANT_MISMATCH";
pub const ERR_BRANCH_MISMATCH: &str = "DEVICE_BRANCH_MISMATCH";
pub const ERR_REQUEST_INVALID: &str = "DEVICE_ENROLLMENT_REQUEST_INVALID";
pub const ERR_RESPONSE_INVALID: &str = "DEVICE_ENROLLMENT_RESPONSE_INVALID";
pub const ERR_WRONG_PURPOSE: &str = "DEVICE_ENROLLMENT_WRONG_PURPOSE";
pub const ERR_CONFLICT: &str = "DEVICE_ENROLLMENT_CONFLICT";
pub const ERR_AUTHORITY_CERT_INVALID: &str = "DEVICE_ENROLLMENT_AUTHORITY_CERT_INVALID";
// M6-B2DE1 §8 — the out-of-band anchor errors.
/// The response's root fingerprint does not match the one the owner confirmed separately.
pub const ERR_ROOT_FINGERPRINT_MISMATCH: &str = "TENANT_ROOT_FINGERPRINT_MISMATCH";
/// A first import needs the separately-confirmed fingerprint; it was not supplied.
pub const ERR_ROOT_FINGERPRINT_REQUIRED: &str = "TENANT_ROOT_FINGERPRINT_REQUIRED";
/// A trust anchor already exists and the response names a DIFFERENT root.
pub const ERR_ANCHOR_CONFLICT: &str = "TENANT_TRUST_ANCHOR_CONFLICT";
pub const ERR_ANCHOR_INVALID: &str = "TENANT_TRUST_ANCHOR_INVALID";
// M6-B2DE2 §7 — the signed enrollment approval.
/// The approval blob is structurally not ours (bad size, missing fields, wrong version).
pub const ERR_APPROVAL_INVALID: &str = "DEVICE_ENROLLMENT_APPROVAL_INVALID";
/// The approval's signature does not verify against the trusted tenant root.
pub const ERR_APPROVAL_SIGNATURE: &str = "DEVICE_ENROLLMENT_APPROVAL_SIGNATURE_INVALID";
/// The approval is validly signed but one of its fields disagrees with the certificate, the
/// response, the device key or the local request it claims to answer.
pub const ERR_APPROVAL_MISMATCH: &str = "DEVICE_ENROLLMENT_APPROVAL_MISMATCH";
/// §7 — no local enrollment request is on disk to check the approval's request id/nonce
/// against. A signed-approval response is only meaningful as the answer to a request THIS
/// device made; without it we cannot prove that, so we refuse rather than assume.
pub const ERR_REQUEST_MISSING: &str = "DEVICE_ENROLLMENT_REQUEST_MISSING";

pub const PURPOSE_REQUEST: &str = "device_enrollment_request";
pub const PURPOSE_RESPONSE: &str = "device_enrollment_response";

/// §8 — the local, never-synced trust anchor file. Public content (a root's public key and
/// fingerprint), but security-critical: it is what a re-import is checked against, so replacing
/// it silently would let a second root in.
const TRUST_ANCHOR_FILENAME: &str = "sync_tenant_trust_anchor.json";
/// §7 — the device's OWN pending enrollment request, persisted the moment it is created so the
/// import path can check the approval's request id + nonce against the request THIS device
/// actually made — "gegen lokalen Request", not against a value the response supplied.
const REQUEST_FILENAME: &str = "sync_device_enrollment_request.json";
pub const FINGERPRINT_HEX_LEN: usize = 64;

// ── §3 — the identity file ──────────────────────────────────────────────────

/// A loaded private device key. Zeroizes on drop; `Debug` is hand-written and redacted.
pub struct DeviceKey {
    seed: [u8; SEED_LEN],
    device_id: String,
    created_at: String,
}

impl Drop for DeviceKey {
    fn drop(&mut self) {
        self.seed.zeroize();
    }
}

impl std::fmt::Debug for DeviceKey {
    /// D21 — a derived `Debug` on a key type is how private keys reach logs.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DeviceKey({}, seed=<redacted>)", trust_root::redact(&self.device_id))
    }
}

impl DeviceKey {
    pub fn device_id(&self) -> &str {
        &self.device_id
    }
    /// Test-only: production reads `created_at` from the certificate, which is signed. The
    /// identity file's copy is convenience, not evidence.
    #[cfg(test)]
    pub fn created_at(&self) -> &str {
        &self.created_at
    }

    fn signing_key(&self) -> ed25519_dalek::SigningKey {
        ed25519_dalek::SigningKey::from_bytes(&self.seed)
    }

    pub fn public_key_b64(&self) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .encode(self.signing_key().verifying_key().to_bytes())
    }

    /// Test-only for now: the public key is what the protocol carries. A fingerprint is a
    /// display convenience, and inventing a UI for it here would be speculation.
    #[cfg(test)]
    pub fn fingerprint(&self) -> String {
        trust_root::fingerprint_of(&self.signing_key().verifying_key().to_bytes())
    }

    /// Sign canonical bytes. This is the device proving possession — the whole point.
    pub fn sign(&self, message: &[u8]) -> Vec<u8> {
        use ed25519_dalek::Signer;
        self.signing_key().sign(message).to_bytes().to_vec()
    }
}

fn identity_path(dir: &Path) -> std::path::PathBuf {
    dir.join(IDENTITY_FILENAME)
}

fn certificate_path(dir: &Path) -> std::path::PathBuf {
    dir.join(CERTIFICATE_FILENAME)
}

/// Test-only. Production asks `resolve_state`, which distinguishes "no identity" from
/// "identity present but unusable" — a boolean here would flatten exactly that difference.
#[cfg(test)]
pub fn identity_exists(dir: &Path) -> bool {
    identity_path(dir).exists()
}

pub fn certificate_exists(dir: &Path) -> bool {
    certificate_path(dir).exists()
}

/// The stored form: `PREFIX` + base64(version ‖ device_id ‖ created_at ‖ seed) would be one
/// option; a small JSON body is another. We use a line-oriented, self-describing text form
/// because it is the one a support engineer can eyeball without a tool — and the seed is the
/// only field that must never be eyeballed, which is why it is last and clearly marked.
fn encode_identity(v: &DeviceKey) -> String {
    use base64::Engine;
    format!(
        "{IDENTITY_PREFIX}{}\nversion={}\ndevice_id={}\ncreated_at={}\npublic_key={}\nseed={}\n",
        IDENTITY_FORMAT_VERSION,
        IDENTITY_FORMAT_VERSION,
        v.device_id,
        v.created_at,
        v.public_key_b64(),
        base64::engine::general_purpose::STANDARD.encode(v.seed),
    )
}

/// Parse. Fail-closed on anything unexpected — this never self-heals (D3).
fn parse_identity(raw: &str) -> Result<DeviceKey, &'static str> {
    use base64::Engine;

    let t = raw.trim();
    if t.is_empty() || !t.starts_with(IDENTITY_PREFIX) {
        return Err(ERR_IDENTITY_INVALID);
    }
    let mut version = None;
    let mut device_id = None;
    let mut created_at = None;
    let mut public_key = None;
    let mut seed_b64 = None;
    for line in t.lines().skip(1) {
        let Some((k, v)) = line.split_once('=') else { continue };
        match k {
            "version" => version = v.parse::<u32>().ok(),
            "device_id" => device_id = Some(v.to_string()),
            "created_at" => created_at = Some(v.to_string()),
            "public_key" => public_key = Some(v.to_string()),
            "seed" => seed_b64 = Some(v.to_string()),
            // An unknown key means a format we have not reasoned about.
            _ => return Err(ERR_IDENTITY_INVALID),
        }
    }
    if version != Some(IDENTITY_FORMAT_VERSION) {
        return Err(ERR_IDENTITY_INVALID);
    }
    let (device_id, created_at, public_key, seed_b64) = (
        device_id.ok_or(ERR_IDENTITY_INVALID)?,
        created_at.ok_or(ERR_IDENTITY_INVALID)?,
        public_key.ok_or(ERR_IDENTITY_INVALID)?,
        seed_b64.ok_or(ERR_IDENTITY_INVALID)?,
    );
    if device_id.is_empty() || device_id.len() > MAX_ID_LEN {
        return Err(ERR_IDENTITY_INVALID);
    }
    if created_at.len() > MAX_TIMESTAMP_LEN {
        return Err(ERR_IDENTITY_INVALID);
    }

    let mut bytes = base64::engine::general_purpose::STANDARD
        .decode(seed_b64.trim())
        .map_err(|_| ERR_IDENTITY_INVALID)?;
    let arr: [u8; SEED_LEN] = bytes.as_slice().try_into().map_err(|_| ERR_IDENTITY_INVALID)?;
    bytes.zeroize();
    // An all-zero seed is what a zeroed or sparse file decodes into. It IS a mathematically
    // valid Ed25519 seed, which is exactly why it must be rejected explicitly: otherwise
    // every damaged install would share one "identity".
    if arr.iter().all(|b| *b == 0) {
        return Err(ERR_IDENTITY_INVALID);
    }

    let key = DeviceKey { seed: arr, device_id, created_at };
    // The file states its own public key; if it disagrees with the seed, the file is
    // internally inconsistent and we do not get to pick which half to believe.
    if key.public_key_b64() != public_key {
        return Err(ERR_IDENTITY_INVALID);
    }
    Ok(key)
}

/// Create the device identity exactly once.
///
/// Publication is tmp + `hard_link`, the contract proven in `install_id.rs` (`3f56d73`):
/// `create_new` on the final path is atomic for the NAME but publishes it *before*
/// `write_all` runs, so a concurrent reader can see an empty file where a key belongs.
/// Writing to a temp name and hard-linking publishes finished content. `rename` will not do
/// — it silently overwrites, and overwriting an identity is the one thing this must never
/// do.
pub fn create_identity(dir: &Path) -> Result<DeviceKey, &'static str> {
    use std::io::Write;

    let path = identity_path(dir);
    if path.exists() {
        return Err(ERR_IDENTITY_EXISTS);
    }
    // §3 — never mint a fresh keypair where a certificate ever existed. That certificate
    // names a public key we would no longer hold, and quietly re-keying would turn "this
    // device lost its key" into "this device is silently a different device".
    if certificate_exists(dir) {
        return Err(ERR_REENROLLMENT_REQUIRED);
    }

    let mut seed = [0u8; SEED_LEN];
    {
        use rand::RngCore;
        // OS CSPRNG, and `try_fill_bytes` so an entropy failure is an error rather than a
        // silently weak key.
        rand::rngs::OsRng.try_fill_bytes(&mut seed).map_err(|_| ERR_IDENTITY_INVALID)?;
    }
    let key = DeviceKey {
        seed,
        device_id: uuid::Uuid::new_v4().to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    let mut body = encode_identity(&key);
    let tmp = dir.join(format!(".{IDENTITY_FILENAME}.{}.tmp", uuid::Uuid::new_v4().as_simple()));
    let result = (|| -> Result<(), &'static str> {
        {
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp)
                .map_err(|_| ERR_IDENTITY_INVALID)?;
            f.write_all(body.as_bytes()).map_err(|_| ERR_IDENTITY_INVALID)?;
            f.sync_all().map_err(|_| ERR_IDENTITY_INVALID)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
            }
        }
        match std::fs::hard_link(&tmp, &path) {
            Ok(()) => Ok(()),
            // The loser of a concurrent create must never clobber the winner.
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(ERR_IDENTITY_EXISTS),
            Err(_) => Err(ERR_IDENTITY_INVALID),
        }
    })();
    // The encoded body held the seed in plaintext; do not leave it in a freed String.
    body.zeroize();
    let _ = std::fs::remove_file(&tmp);
    result?;
    Ok(key)
}

pub fn load_identity(dir: &Path) -> Result<DeviceKey, &'static str> {
    let raw = match std::fs::read_to_string(identity_path(dir)) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(ERR_IDENTITY_MISSING),
        Err(_) => return Err(ERR_IDENTITY_INVALID),
    };
    parse_identity(&raw)
}

pub fn load_or_create_identity(dir: &Path) -> Result<DeviceKey, &'static str> {
    match load_identity(dir) {
        Ok(k) => Ok(k),
        Err(ERR_IDENTITY_MISSING) => create_identity(dir),
        // A damaged file is NOT a reason to make a new one. D3: fail closed.
        Err(e) => Err(e),
    }
}

// ── §3 — the state machine ──────────────────────────────────────────────────

/// What this machine's device identity actually is, right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceState {
    /// No key, no certificate. A device may create an identity.
    IdentityMissing,
    /// Key present, no certificate. It can request enrollment.
    Unenrolled,
    /// Key + matching certificate. It can prove who it is.
    Enrolled,
    /// A certificate file existed and the key does not: possession is unprovable forever.
    ReenrollmentRequired,
    /// The key is there, a certificate was expected but is unreadable.
    CertificateMissing,
    /// The key file is present but unusable. Fail-closed, never replaced.
    IdentityCorrupt,
    /// The registry says this device is revoked/compromised. Local files are irrelevant.
    Revoked,
}

impl DeviceState {
    pub fn as_str(self) -> &'static str {
        match self {
            DeviceState::IdentityMissing => "identity_missing",
            DeviceState::Unenrolled => "unenrolled",
            DeviceState::Enrolled => "enrolled",
            DeviceState::ReenrollmentRequired => "reenrollment_required",
            DeviceState::CertificateMissing => "certificate_missing",
            DeviceState::IdentityCorrupt => "identity_corrupt",
            DeviceState::Revoked => "revoked",
        }
    }
    /// The single question anything asking "can this device prove itself?" needs answered.
    pub fn can_prove_possession(self) -> bool {
        matches!(self, DeviceState::Enrolled)
    }
}

/// Resolve the local device situation. Read-only: never creates, repairs or deletes.
///
/// The interesting branch is `ReenrollmentRequired`: a certificate on disk with no key. That
/// is not "nearly enrolled" — it is the terminal case. The certificate names a public key
/// whose private half is gone; no amount of local repair brings it back, and minting a new
/// keypair would silently make this a different device under an old name.
pub fn resolve_state(dir: &Path) -> DeviceState {
    let has_cert = certificate_exists(dir);
    match load_identity(dir) {
        Ok(key) => {
            if !has_cert {
                return DeviceState::Unenrolled;
            }
            match load_certificate(dir) {
                Ok(cert) => {
                    if cert.payload.device_id != key.device_id()
                        || cert.payload.device_public_key != key.public_key_b64()
                    {
                        // A certificate for another device sitting next to this key.
                        DeviceState::IdentityCorrupt
                    } else {
                        DeviceState::Enrolled
                    }
                }
                Err(_) => DeviceState::CertificateMissing,
            }
        }
        Err(ERR_IDENTITY_MISSING) if has_cert => DeviceState::ReenrollmentRequired,
        Err(ERR_IDENTITY_MISSING) => DeviceState::IdentityMissing,
        Err(_) => DeviceState::IdentityCorrupt,
    }
}

/// The local view is not the whole truth, and this is where that gets said.
///
/// `resolve_state` reads FILES. It can see that a key and a certificate agree — it cannot
/// see that the owner revoked this device an hour ago, because revocation is a row in the
/// server database. A device asking only its own disk would answer "Enrolled" forever.
///
/// So: when the registry is reachable, it wins. `DeviceState::Revoked` is reachable ONLY
/// through here, which is the honest shape — a device cannot revoke itself, and it cannot
/// know it was revoked without asking.
pub fn resolve_state_with_registry(
    conn: &rusqlite::Connection,
    dir: &Path,
) -> DeviceState {
    let local = resolve_state(dir);
    let Ok(key) = load_identity(dir) else { return local };
    match load_device(conn, key.device_id()) {
        Ok(Some(rec)) => match rec.state {
            // The registry's verdict overrides a locally healthy-looking pair of files.
            RegistryState::Revoked | RegistryState::Compromised | RegistryState::Retired => {
                DeviceState::Revoked
            }
            RegistryState::ReenrollmentRequired => DeviceState::ReenrollmentRequired,
            _ => local,
        },
        // Not in the registry, or the registry is unreadable: fall back to what the files
        // say. This is NOT a permissive default — an unenrolled device is already unable to
        // prove anything, and a device whose row is missing has nothing granting it rights.
        _ => local,
    }
}

// ── §4 — the device certificate ─────────────────────────────────────────────

use serde::{Deserialize, Serialize};

/// An `Option` field that must be PRESENT (it may be null).
///
/// Attaching `deserialize_with` and omitting `default` is what turns off serde's implicit
/// "missing Option ⇒ None" — verified empirically in B2BC2, not assumed.
fn required_option<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d)
}

/// The signed part. Field order IS the specification (see `canonical.rs`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DeviceCertificatePayload {
    pub format_version: u32,
    pub tenant_id: String,
    pub branch_id: String,

    pub device_id: String,
    /// The certificate binds BOTH: the install id says which machine, the public key says
    /// which keypair. Neither alone is enough — an install id is not a secret and proves no
    /// possession; a key without the install id would travel to any machine.
    pub install_id: String,
    pub device_public_key: String,

    pub device_role: String,
    pub capabilities: Vec<String>,
    pub protocol_min: i64,
    pub protocol_max: i64,

    pub certificate_serial: String,
    pub authority_id: String,
    pub authority_epoch: i64,
    pub root_key_id: String,
    pub root_generation: i64,

    pub issued_at: String,
    #[serde(deserialize_with = "required_option")]
    pub previous_certificate_serial: Option<String>,
}

impl DeviceCertificatePayload {
    /// The exact bytes signed and hashed — `canonical_bytes_v1`, device-cert domain.
    pub fn canonical(&self) -> Vec<u8> {
        let mut w = CanonicalWriter::new(canonical::DOMAIN_DEVICE_CERT, self.format_version);
        w.string(&self.tenant_id)
            .string(&self.branch_id)
            .string(&self.device_id)
            .string(&self.install_id)
            .string(&self.device_public_key)
            .string(&self.device_role);
        // A length prefix before the list, then each element length-prefixed: without the
        // count, ["a","b"] and ["ab"] would encode identically once concatenated.
        w.i64(self.capabilities.len() as i64);
        for c in &self.capabilities {
            w.string(c);
        }
        w.i64(self.protocol_min)
            .i64(self.protocol_max)
            .string(&self.certificate_serial)
            .string(&self.authority_id)
            .i64(self.authority_epoch)
            .string(&self.root_key_id)
            .i64(self.root_generation)
            .string(&self.issued_at)
            .opt_string(self.previous_certificate_serial.as_deref());
        w.finish()
    }

    pub fn payload_hash(&self) -> String {
        canonical::sha256_hex(&self.canonical())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DeviceCertificate {
    pub payload: DeviceCertificatePayload,
    /// base64 Ed25519 signature by the TENANT ROOT over `payload.canonical()`.
    pub signature: String,
}

impl DeviceCertificate {
    pub fn to_json(&self) -> Result<String, &'static str> {
        serde_json::to_string_pretty(self).map_err(|_| ERR_CERT_INVALID)
    }

    /// §4 — strict. Size cap first, then structure; nothing expensive before either.
    pub fn from_json(raw: &str) -> Result<DeviceCertificate, &'static str> {
        if raw.len() > MAX_CERTIFICATE_BYTES {
            return Err(ERR_CERT_INVALID);
        }
        let c: DeviceCertificate = serde_json::from_str(raw).map_err(|_| ERR_CERT_INVALID)?;
        c.validate_structure()?;
        Ok(c)
    }

    fn validate_structure(&self) -> Result<(), &'static str> {
        let p = &self.payload;
        if p.format_version != CERTIFICATE_VERSION {
            return Err(ERR_CERT_INVALID);
        }
        for s in [
            &p.tenant_id,
            &p.branch_id,
            &p.device_id,
            &p.install_id,
            &p.certificate_serial,
            &p.authority_id,
            &p.root_key_id,
            &p.device_role,
        ] {
            if s.is_empty() || s.len() > MAX_ID_LEN {
                return Err(ERR_CERT_INVALID);
            }
        }
        if p.previous_certificate_serial.as_ref().is_some_and(|s| s.len() > MAX_ID_LEN) {
            return Err(ERR_CERT_INVALID);
        }
        if p.issued_at.len() > MAX_TIMESTAMP_LEN {
            return Err(ERR_CERT_INVALID);
        }
        if p.authority_epoch < 1 || p.root_generation < 1 {
            return Err(ERR_CERT_INVALID);
        }
        // A protocol range that is empty or inverted is not a range.
        if p.protocol_min < 1 || p.protocol_max < p.protocol_min {
            return Err(ERR_CERT_INVALID);
        }
        if p.capabilities.len() > MAX_CAPABILITIES {
            return Err(ERR_CERT_INVALID);
        }
        for c in &p.capabilities {
            if c.is_empty() || c.len() > MAX_ID_LEN {
                return Err(ERR_CERT_INVALID);
            }
        }
        // Exact encodings — fixed by the algorithms, so anything else was not ours.
        if p.device_public_key.len() != PUBLIC_KEY_B64_LEN {
            return Err(ERR_CERT_INVALID);
        }
        use base64::Engine;
        if base64::engine::general_purpose::STANDARD
            .decode(&p.device_public_key)
            .map_err(|_| ERR_CERT_INVALID)?
            .len()
            != 32
        {
            return Err(ERR_CERT_INVALID);
        }
        if self.signature.len() != SIGNATURE_B64_LEN {
            return Err(ERR_CERT_SIGNATURE);
        }
        if base64::engine::general_purpose::STANDARD
            .decode(&self.signature)
            .map_err(|_| ERR_CERT_SIGNATURE)?
            .len()
            != 64
        {
            return Err(ERR_CERT_SIGNATURE);
        }
        Ok(())
    }
}

/// What a caller must prove about the context before a device certificate means anything.
pub struct DeviceVerifyContext<'a> {
    pub tenant_id: &'a str,
    pub branch_id: &'a str,
    pub root: &'a TrustRootRecord,
    /// `Some` = also require the certificate to name THIS installation.
    pub expect_install_id: Option<&'a str>,
    /// `Some` = also require it to name THIS device key.
    pub expect_public_key: Option<&'a str>,
}

/// Verify from scratch: signature first, then every field. The stored columns are never
/// trusted — everything is re-derived from the signed blob.
pub fn verify_certificate(
    cert: &DeviceCertificate,
    ctx: &DeviceVerifyContext,
) -> Result<(), &'static str> {
    use base64::Engine;

    cert.validate_structure()?;
    // The certificate must be signed by the root we actually trust, at the generation we
    // know.
    if cert.payload.root_key_id != ctx.root.root_key_id
        || cert.payload.root_generation != ctx.root.generation
    {
        return Err(ERR_CERT_SIGNATURE);
    }
    if !ctx.root.state.may_sign() {
        return Err(ERR_CERT_SIGNATURE);
    }
    let sig = base64::engine::general_purpose::STANDARD
        .decode(&cert.signature)
        .map_err(|_| ERR_CERT_SIGNATURE)?;
    if !trust_root::verify_signature(&ctx.root.public_key, &cert.payload.canonical(), &sig) {
        return Err(ERR_CERT_SIGNATURE);
    }
    if cert.payload.tenant_id != ctx.tenant_id {
        return Err(ERR_TENANT_MISMATCH);
    }
    if cert.payload.branch_id != ctx.branch_id {
        return Err(ERR_BRANCH_MISMATCH);
    }
    // D12 — a certificate naming another installation is perfectly valid; it just is not
    // ours. This is the check that makes a copied certificate useless.
    if let Some(inst) = ctx.expect_install_id {
        if cert.payload.install_id != inst {
            return Err(ERR_INSTALL_MISMATCH);
        }
    }
    // D13 — and it must name the key we actually hold.
    if let Some(pk) = ctx.expect_public_key {
        if cert.payload.device_public_key != pk {
            return Err(ERR_KEY_MISMATCH);
        }
    }
    Ok(())
}

// ── The certificate file ────────────────────────────────────────────────────

/// Store the certificate atomically. Idempotent for an identical re-import (D15),
/// fail-closed on a contradicting one (D16).
pub fn store_certificate(dir: &Path, cert: &DeviceCertificate) -> Result<(), &'static str> {
    use std::io::Write;

    let path = certificate_path(dir);
    let body = cert.to_json()?;

    if path.exists() {
        let existing = load_certificate(dir)?;
        return if existing.payload.certificate_serial == cert.payload.certificate_serial
            && existing.signature == cert.signature
        {
            Ok(())
        } else if existing.payload.device_id != cert.payload.device_id {
            Err(ERR_DEVICE_MISMATCH)
        } else {
            // Same device, different certificate: a re-enrollment. Replacing it is a
            // deliberate act with its own path, not something an import decides.
            Err(ERR_CONFLICT)
        };
    }

    let tmp = dir.join(format!(".{CERTIFICATE_FILENAME}.{}.tmp", uuid::Uuid::new_v4().as_simple()));
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|_| ERR_CERT_INVALID)?;
        f.write_all(body.as_bytes()).map_err(|_| ERR_CERT_INVALID)?;
        f.sync_all().map_err(|_| ERR_CERT_INVALID)?;
    }
    let published = std::fs::hard_link(&tmp, &path);
    let _ = std::fs::remove_file(&tmp);
    match published {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(_) => Err(ERR_CERT_INVALID),
    }
}

pub fn load_certificate(dir: &Path) -> Result<DeviceCertificate, &'static str> {
    let raw = match std::fs::read_to_string(certificate_path(dir)) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(ERR_CERT_MISSING),
        Err(_) => return Err(ERR_CERT_INVALID),
    };
    DeviceCertificate::from_json(&raw)
}

/// Test-only for now. Replace the certificate during re-enrollment (§9). Separate from `store_certificate`
/// because the semantics differ: this one knowingly discards a previous statement, and that
/// must never be a side effect of an import.
#[cfg(test)]
pub fn replace_certificate(dir: &Path, cert: &DeviceCertificate) -> Result<(), &'static str> {
    let path = certificate_path(dir);
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
    store_certificate(dir, cert)
}

/// Remove the local identity — ONLY for a re-enrollment the owner asked for (§9).
///
/// Deliberately narrow and deliberately loud in its name: no automatic path calls this. A
/// device that lost its key gets `DEVICE_REENROLLMENT_REQUIRED` and stops; deleting a key
/// because it looks unusable is how a working device becomes a new one behind the owner's
/// back.
#[cfg(test)]
pub fn discard_identity_for_reenrollment(dir: &Path) -> Result<(), &'static str> {
    let _ = std::fs::remove_file(identity_path(dir));
    let _ = std::fs::remove_file(certificate_path(dir));
    // §7 — the stored request named the OLD key. Leaving it would let a re-enrollment's import
    // check the approval against a request for a device that no longer exists.
    let _ = std::fs::remove_file(request_path(dir));
    Ok(())
}

// ── §6 — the enrollment request ─────────────────────────────────────────────

/// `device-enrollment-request.lataif` — the device asking to be let in.
///
/// Signed by the DEVICE's own key. That signature is the one genuinely new thing in this
/// system: it proves possession of a private key, which the §2 audit found nothing else
/// does today.
///
/// What it proves: whoever wrote this file holds the private half of `device_public_key`,
/// and wrote it about this `device_id` and this `install_id`.
///
/// What it does NOT prove — hence every field is named `requested_*`: owner consent, tenant
/// membership, branch membership, or any capability. Those are the owner's to grant (§7). A
/// self-signed request that granted them would be a device promoting itself, which is the
/// whole class of bug M6-B2A exists to close.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EnrollmentRequest {
    pub format_version: u32,
    pub purpose: String,

    pub request_id: String,
    pub device_id: String,
    pub install_id: String,
    pub device_public_key: String,

    pub requested_tenant_id: String,
    pub requested_branch_id: String,
    pub requested_role: String,
    pub requested_capabilities: Vec<String>,
    pub protocol_min: i64,
    pub protocol_max: i64,

    pub created_at: String,
    /// Fresh randomness per request. There is no server challenge to replay against — §2
    /// found no nonce model anywhere — so this makes each request individually
    /// identifiable. It is not, by itself, replay protection.
    pub request_nonce: String,
    /// base64 Ed25519 over `canonical()`, by the device key.
    pub signature: String,
}

impl EnrollmentRequest {
    fn canonical(&self) -> Vec<u8> {
        let mut w =
            CanonicalWriter::new(canonical::DOMAIN_DEVICE_ENROLLMENT_REQUEST, self.format_version);
        w.string(&self.purpose)
            .string(&self.request_id)
            .string(&self.device_id)
            .string(&self.install_id)
            .string(&self.device_public_key)
            .string(&self.requested_tenant_id)
            .string(&self.requested_branch_id)
            .string(&self.requested_role);
        // Count first, then each element length-prefixed. Without the count, ["a","b"] and
        // ["ab"] would produce the same bytes once concatenated.
        w.i64(self.requested_capabilities.len() as i64);
        for c in &self.requested_capabilities {
            w.string(c);
        }
        w.i64(self.protocol_min)
            .i64(self.protocol_max)
            .string(&self.created_at)
            .string(&self.request_nonce);
        w.finish()
    }

    pub fn request_hash(&self) -> String {
        canonical::sha256_hex(&self.canonical())
    }

    pub fn to_json(&self) -> Result<String, &'static str> {
        serde_json::to_string_pretty(self).map_err(|_| ERR_REQUEST_INVALID)
    }

    pub fn from_json(raw: &str) -> Result<EnrollmentRequest, &'static str> {
        if raw.len() > MAX_REQUEST_BYTES {
            return Err(ERR_REQUEST_INVALID);
        }
        let r: EnrollmentRequest = serde_json::from_str(raw).map_err(|_| ERR_REQUEST_INVALID)?;
        r.validate_structure()?;
        Ok(r)
    }

    fn validate_structure(&self) -> Result<(), &'static str> {
        if self.format_version != IDENTITY_FORMAT_VERSION {
            return Err(ERR_REQUEST_INVALID);
        }
        // The sibling format is refused by name, so "this is a response, not a request" is a
        // distinct fact from "this purpose is gibberish".
        if self.purpose == PURPOSE_RESPONSE {
            return Err(ERR_WRONG_PURPOSE);
        }
        if self.purpose != PURPOSE_REQUEST {
            return Err(ERR_WRONG_PURPOSE);
        }
        for s in [
            &self.request_id,
            &self.device_id,
            &self.install_id,
            &self.requested_tenant_id,
            &self.requested_branch_id,
            &self.requested_role,
        ] {
            if s.is_empty() || s.len() > MAX_ID_LEN {
                return Err(ERR_REQUEST_INVALID);
            }
        }
        if self.created_at.len() > MAX_TIMESTAMP_LEN {
            return Err(ERR_REQUEST_INVALID);
        }
        if self.protocol_min < 1 || self.protocol_max < self.protocol_min {
            return Err(ERR_REQUEST_INVALID);
        }
        if self.requested_capabilities.len() > MAX_CAPABILITIES {
            return Err(ERR_REQUEST_INVALID);
        }
        for c in &self.requested_capabilities {
            if c.is_empty() || c.len() > MAX_ID_LEN {
                return Err(ERR_REQUEST_INVALID);
            }
        }
        use base64::Engine;
        if self.device_public_key.len() != PUBLIC_KEY_B64_LEN
            || base64::engine::general_purpose::STANDARD
                .decode(&self.device_public_key)
                .map_err(|_| ERR_REQUEST_INVALID)?
                .len()
                != 32
        {
            return Err(ERR_REQUEST_INVALID);
        }
        if self.request_nonce.len() != NONCE_B64_LEN
            || base64::engine::general_purpose::STANDARD
                .decode(&self.request_nonce)
                .map_err(|_| ERR_REQUEST_INVALID)?
                .len()
                != NONCE_LEN
        {
            return Err(ERR_REQUEST_INVALID);
        }
        if self.signature.len() != SIGNATURE_B64_LEN
            || base64::engine::general_purpose::STANDARD
                .decode(&self.signature)
                .map_err(|_| ERR_REQUEST_INVALID)?
                .len()
                != 64
        {
            return Err(ERR_REQUEST_INVALID);
        }
        Ok(())
    }

    /// D7 — the proof-of-possession check.
    ///
    /// The signature verifies against the public key the request itself carries. That is
    /// what makes the file self-contained — and also exactly why it proves only possession
    /// and nothing about who the holder is or what they may do.
    pub fn verify_self_signature(&self) -> Result<(), &'static str> {
        self.validate_structure()?;
        use base64::Engine;
        let sig = base64::engine::general_purpose::STANDARD
            .decode(&self.signature)
            .map_err(|_| ERR_REQUEST_INVALID)?;
        if !trust_root::verify_signature(&self.device_public_key, &self.canonical(), &sig) {
            return Err(ERR_REQUEST_INVALID);
        }
        Ok(())
    }
}

/// Build and sign an enrollment request on the device.
pub fn create_enrollment_request(
    key: &DeviceKey,
    install_id: &str,
    requested_tenant_id: &str,
    requested_branch_id: &str,
    requested_role: &str,
    requested_capabilities: &[String],
    protocol_min: i64,
    protocol_max: i64,
) -> Result<EnrollmentRequest, &'static str> {
    use base64::Engine;
    let mut nonce = [0u8; NONCE_LEN];
    {
        use rand::RngCore;
        rand::rngs::OsRng.try_fill_bytes(&mut nonce).map_err(|_| ERR_REQUEST_INVALID)?;
    }
    let mut req = EnrollmentRequest {
        format_version: IDENTITY_FORMAT_VERSION,
        purpose: PURPOSE_REQUEST.to_string(),
        request_id: uuid::Uuid::new_v4().to_string(),
        device_id: key.device_id().to_string(),
        install_id: install_id.to_string(),
        device_public_key: key.public_key_b64(),
        requested_tenant_id: requested_tenant_id.to_string(),
        requested_branch_id: requested_branch_id.to_string(),
        requested_role: requested_role.to_string(),
        requested_capabilities: requested_capabilities.to_vec(),
        protocol_min,
        protocol_max,
        created_at: chrono::Utc::now().to_rfc3339(),
        request_nonce: base64::engine::general_purpose::STANDARD.encode(nonce),
        signature: String::new(),
    };
    req.signature = base64::engine::general_purpose::STANDARD.encode(key.sign(&req.canonical()));
    req.validate_structure()?;
    Ok(req)
}

fn request_path(dir: &Path) -> std::path::PathBuf {
    dir.join(REQUEST_FILENAME)
}

/// §7 — persist the device's own pending request, so `import_enrollment_response` can later
/// check the signed approval's request id + nonce against the request THIS device made.
///
/// Unlike the identity/certificate/anchor (write-once, never overwritten), a request is
/// legitimately re-created before enrollment completes — a device may ask again — so this
/// OVERWRITES via tmp + rename. The nonce it stores is not a secret; what matters is that it
/// is local and predates any response, so a response cannot fabricate a matching one.
pub fn store_enrollment_request(dir: &Path, req: &EnrollmentRequest) -> Result<(), &'static str> {
    use std::io::Write;
    let path = request_path(dir);
    let body = req.to_json()?;
    let tmp = dir.join(format!(".{REQUEST_FILENAME}.{}.tmp", uuid::Uuid::new_v4().as_simple()));
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|_| ERR_REQUEST_INVALID)?;
        f.write_all(body.as_bytes()).map_err(|_| ERR_REQUEST_INVALID)?;
        f.sync_all().map_err(|_| ERR_REQUEST_INVALID)?;
    }
    // rename overwrites an existing file on both Windows and unix — the request supersedes any
    // earlier one.
    let published = std::fs::rename(&tmp, &path);
    if published.is_err() {
        let _ = std::fs::remove_file(&tmp);
        return Err(ERR_REQUEST_INVALID);
    }
    Ok(())
}

/// §7 — load the device's own pending request. `None` when there is none on disk.
pub fn load_enrollment_request(dir: &Path) -> Result<Option<EnrollmentRequest>, &'static str> {
    match std::fs::read_to_string(request_path(dir)) {
        Ok(raw) => Ok(Some(EnrollmentRequest::from_json(&raw)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(ERR_REQUEST_INVALID),
    }
}

// ── §7 — the enrollment response ────────────────────────────────────────────

/// `device-enrollment-response.lataif` — the owner's answer, carrying the FULL chain.
///
/// M6-B2DE1 §7 — a response is no longer just a device certificate. It carries the whole
/// chain the target needs to verify from a root it does not yet know: the tenant root's
/// public key and fingerprint, the authority certificate (root-signed) that proves the
/// issuing primary was the authority, and the device certificate (root-signed) that binds
/// this device. An internally consistent chain is not enough — an attacker can build one
/// with the right tenant/branch strings (E3). What anchors it is §8's out-of-band
/// fingerprint, checked at first import.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EnrollmentResponse {
    pub format_version: u32,
    pub purpose: String,
    pub request_id: String,
    pub device_id: String,
    pub install_id: String,

    /// §7 — the tenant root, so the target can pin it out-of-band (§8) instead of trusting a
    /// root it was simply handed. The fingerprint MUST equal SHA-256 of the public key; a
    /// response where they disagree is refused before anything else.
    pub tenant_root_public_key: String,
    pub tenant_root_fingerprint: String,

    /// §7 — the root-signed authority certificate of the issuing primary, verbatim. Proves
    /// the authority named in the device certificate was real and root-blessed at issue time.
    pub authority_certificate: String,

    /// The root-signed device certificate, verbatim, so the device re-verifies from scratch.
    pub device_certificate: String,

    /// §7 — the authority-signed enrollment approval (verbatim JSON). This is what makes the
    /// rest of the response trustworthy field-by-field: it binds the request id + nonce, the
    /// device identity, the granted role/capabilities/protocol, the device certificate's serial
    /// and hash, and the registry record hash into ONE signed statement. Everything the target
    /// checks below is checked against THIS, not against a bare response field.
    pub approval: String,

    /// SHA-256 over the canonical registry record. Now cross-checked against the SIGNED
    /// `approval.registry_record_hash`, so it is no longer merely advisory — a response that
    /// disagrees with its own signed approval is refused.
    pub registry_record_hash: String,
    pub issued_at: String,
}

impl EnrollmentResponse {
    pub fn to_json(&self) -> Result<String, &'static str> {
        serde_json::to_string_pretty(self).map_err(|_| ERR_RESPONSE_INVALID)
    }

    pub fn from_json(raw: &str) -> Result<EnrollmentResponse, &'static str> {
        if raw.len() > MAX_RESPONSE_BYTES {
            return Err(ERR_RESPONSE_INVALID);
        }
        let r: EnrollmentResponse = serde_json::from_str(raw).map_err(|_| ERR_RESPONSE_INVALID)?;
        if r.format_version != IDENTITY_FORMAT_VERSION {
            return Err(ERR_RESPONSE_INVALID);
        }
        if r.purpose == PURPOSE_REQUEST {
            return Err(ERR_WRONG_PURPOSE);
        }
        if r.purpose != PURPOSE_RESPONSE {
            return Err(ERR_WRONG_PURPOSE);
        }
        for s in [&r.request_id, &r.device_id, &r.install_id] {
            if s.is_empty() || s.len() > MAX_ID_LEN {
                return Err(ERR_RESPONSE_INVALID);
            }
        }
        if r.issued_at.len() > MAX_TIMESTAMP_LEN {
            return Err(ERR_RESPONSE_INVALID);
        }
        if r.registry_record_hash.len() != HASH_HEX_LEN
            || !r.registry_record_hash.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err(ERR_RESPONSE_INVALID);
        }
        if r.device_certificate.len() > MAX_CERTIFICATE_BYTES
            || r.authority_certificate.len() > MAX_CERTIFICATE_BYTES
            || r.approval.len() > MAX_CERTIFICATE_BYTES
        {
            return Err(ERR_RESPONSE_INVALID);
        }
        // §7/§8 — the root the chain hangs on. Exact encodings, and the fingerprint must be
        // the real SHA-256 of the public key — an internally inconsistent root is refused
        // before it can be pinned or compared to anything.
        if r.tenant_root_public_key.len() != PUBLIC_KEY_B64_LEN {
            return Err(ERR_RESPONSE_INVALID);
        }
        use base64::Engine;
        if base64::engine::general_purpose::STANDARD
            .decode(&r.tenant_root_public_key)
            .map_err(|_| ERR_RESPONSE_INVALID)?
            .len()
            != 32
        {
            return Err(ERR_RESPONSE_INVALID);
        }
        if r.tenant_root_fingerprint.len() != FINGERPRINT_HEX_LEN
            || !r.tenant_root_fingerprint.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err(ERR_RESPONSE_INVALID);
        }
        Ok(r)
    }
}

// ── §7 — the signed enrollment approval ──────────────────────────────────────

/// §7 — the signed part of a device-enrollment approval.
///
/// Field order IS the specification (see `canonical.rs`). This object closes the "unsigned
/// response metadata" gap: role, capabilities, protocol range and the registry hash used to be
/// conveyed as plain response fields, trusted only because they happened to match a signed
/// certificate. Here they are signed directly, together with the request id + nonce that tie
/// the approval to the specific request this device made.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DeviceEnrollmentApprovalPayload {
    pub format_version: u32,

    // Freshness / anti-replay: which request this approval answers.
    pub request_id: String,
    pub request_nonce: String,

    // Device identity.
    pub device_id: String,
    pub install_id: String,
    pub device_public_key: String,

    // The grant the owner decided — never what the request asked for.
    pub tenant_id: String,
    pub branch_id: String,
    pub granted_role: String,
    pub granted_capabilities: Vec<String>,
    pub protocol_min: i64,
    pub protocol_max: i64,

    // Binding to the issued certificate and the registry row.
    pub device_certificate_serial: String,
    pub device_certificate_hash: String,
    pub registry_record_hash: String,
    pub issued_at: String,
}

impl DeviceEnrollmentApprovalPayload {
    /// The exact bytes signed — `canonical_bytes_v1`, approval domain.
    pub fn canonical(&self) -> Vec<u8> {
        let mut w =
            CanonicalWriter::new(canonical::DOMAIN_DEVICE_ENROLLMENT_APPROVAL, self.format_version);
        w.string(&self.request_id)
            .string(&self.request_nonce)
            .string(&self.device_id)
            .string(&self.install_id)
            .string(&self.device_public_key)
            .string(&self.tenant_id)
            .string(&self.branch_id)
            .string(&self.granted_role);
        // Count-prefixed list, exactly like the certificate's capabilities.
        w.i64(self.granted_capabilities.len() as i64);
        for c in &self.granted_capabilities {
            w.string(c);
        }
        w.i64(self.protocol_min)
            .i64(self.protocol_max)
            .string(&self.device_certificate_serial)
            .string(&self.device_certificate_hash)
            .string(&self.registry_record_hash)
            .string(&self.issued_at);
        w.finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DeviceEnrollmentApproval {
    pub payload: DeviceEnrollmentApprovalPayload,
    /// base64 Ed25519 signature by the tenant ROOT (which the active authority holds and uses —
    /// there is no separate authority key) over `payload.canonical()`.
    pub signature: String,
}

impl DeviceEnrollmentApproval {
    pub fn to_json(&self) -> Result<String, &'static str> {
        serde_json::to_string_pretty(self).map_err(|_| ERR_APPROVAL_INVALID)
    }

    /// §7 — strict. Size cap, version, field bounds, exact signature encoding — cheap
    /// structural checks before any signature maths.
    pub fn from_json(raw: &str) -> Result<DeviceEnrollmentApproval, &'static str> {
        if raw.len() > MAX_CERTIFICATE_BYTES {
            return Err(ERR_APPROVAL_INVALID);
        }
        let a: DeviceEnrollmentApproval =
            serde_json::from_str(raw).map_err(|_| ERR_APPROVAL_INVALID)?;
        a.validate_structure()?;
        Ok(a)
    }

    fn validate_structure(&self) -> Result<(), &'static str> {
        let p = &self.payload;
        if p.format_version != IDENTITY_FORMAT_VERSION {
            return Err(ERR_APPROVAL_INVALID);
        }
        for s in [
            &p.request_id,
            &p.device_id,
            &p.install_id,
            &p.tenant_id,
            &p.branch_id,
            &p.granted_role,
            &p.device_certificate_serial,
        ] {
            if s.is_empty() || s.len() > MAX_ID_LEN {
                return Err(ERR_APPROVAL_INVALID);
            }
        }
        if p.issued_at.len() > MAX_TIMESTAMP_LEN {
            return Err(ERR_APPROVAL_INVALID);
        }
        if p.protocol_min < 1 || p.protocol_max < p.protocol_min {
            return Err(ERR_APPROVAL_INVALID);
        }
        if p.granted_capabilities.len() > MAX_CAPABILITIES {
            return Err(ERR_APPROVAL_INVALID);
        }
        for c in &p.granted_capabilities {
            if c.is_empty() || c.len() > MAX_ID_LEN {
                return Err(ERR_APPROVAL_INVALID);
            }
        }
        use base64::Engine;
        // Two SHA-256 hex hashes.
        for h in [&p.device_certificate_hash, &p.registry_record_hash] {
            if h.len() != HASH_HEX_LEN || !h.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err(ERR_APPROVAL_INVALID);
            }
        }
        if p.device_public_key.len() != PUBLIC_KEY_B64_LEN
            || base64::engine::general_purpose::STANDARD
                .decode(&p.device_public_key)
                .map_err(|_| ERR_APPROVAL_INVALID)?
                .len()
                != 32
        {
            return Err(ERR_APPROVAL_INVALID);
        }
        if p.request_nonce.len() != NONCE_B64_LEN
            || base64::engine::general_purpose::STANDARD
                .decode(&p.request_nonce)
                .map_err(|_| ERR_APPROVAL_INVALID)?
                .len()
                != NONCE_LEN
        {
            return Err(ERR_APPROVAL_INVALID);
        }
        if self.signature.len() != SIGNATURE_B64_LEN {
            return Err(ERR_APPROVAL_SIGNATURE);
        }
        if base64::engine::general_purpose::STANDARD
            .decode(&self.signature)
            .map_err(|_| ERR_APPROVAL_SIGNATURE)?
            .len()
            != 64
        {
            return Err(ERR_APPROVAL_SIGNATURE);
        }
        Ok(())
    }

    /// §7/§8 — verify the approval against the trusted root and bind it to the concrete objects
    /// it claims to describe: the LOCAL request (id + nonce + key), this device's key + install,
    /// the issued device certificate (identity, grant, serial, hash), and the response's
    /// registry hash. Every one of these is a signed field, so a mismatch is either a forgery or
    /// a mix-and-match of pieces from two different enrollments.
    #[allow(clippy::too_many_arguments)]
    pub fn verify(
        &self,
        root: &TrustRootRecord,
        local_request: &EnrollmentRequest,
        device_key_b64: &str,
        install_id: &str,
        dcert: &DeviceCertificate,
        response_registry_hash: &str,
    ) -> Result<(), &'static str> {
        use base64::Engine;
        self.validate_structure()?;

        // Signed by the root we actually trust (pinned/confirmed), over the canonical bytes.
        if !root.state.may_sign() {
            return Err(ERR_APPROVAL_SIGNATURE);
        }
        let sig = base64::engine::general_purpose::STANDARD
            .decode(&self.signature)
            .map_err(|_| ERR_APPROVAL_SIGNATURE)?;
        if !trust_root::verify_signature(&root.public_key, &self.payload.canonical(), &sig) {
            return Err(ERR_APPROVAL_SIGNATURE);
        }

        let p = &self.payload;
        // Against the LOCAL request: the id and the nonce THIS device generated. An approval for
        // some other request of ours — or a replayed one — does not match.
        if p.request_id != local_request.request_id
            || p.request_nonce != local_request.request_nonce
        {
            return Err(ERR_APPROVAL_MISMATCH);
        }
        // Against this device: the key and the install id we hold (and the request's own key).
        if p.device_public_key != device_key_b64
            || p.device_public_key != local_request.device_public_key
            || p.install_id != install_id
        {
            return Err(ERR_APPROVAL_MISMATCH);
        }
        // Against the DEVICE CERTIFICATE: identity, grant, serial and hash. The approval and the
        // certificate are two independently signed objects; requiring them to agree is what
        // stops a valid approval being paired with a valid certificate from another enrollment.
        let c = &dcert.payload;
        if p.device_id != c.device_id
            || p.tenant_id != c.tenant_id
            || p.branch_id != c.branch_id
            || p.granted_role != c.device_role
            || p.granted_capabilities != c.capabilities
            || p.protocol_min != c.protocol_min
            || p.protocol_max != c.protocol_max
            || p.device_certificate_serial != c.certificate_serial
            || p.device_certificate_hash != c.payload_hash()
        {
            return Err(ERR_APPROVAL_MISMATCH);
        }
        // Against the response's registry hash — now a signed value, no longer advisory.
        if p.registry_record_hash != response_registry_hash {
            return Err(ERR_APPROVAL_MISMATCH);
        }
        Ok(())
    }
}

// ── §5/§7 — the server-authoritative registry ───────────────────────────────

use rusqlite::{params, Connection, OptionalExtension};

use super::primary::OwnerAuth;
use super::trust_root::RootKey;

/// Lifecycle of a device row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryState {
    Pending,
    Active,
    Revoked,
    Retired,
    Compromised,
    ReenrollmentRequired,
}

impl RegistryState {
    pub fn as_str(self) -> &'static str {
        match self {
            RegistryState::Pending => "pending",
            RegistryState::Active => "active",
            RegistryState::Revoked => "revoked",
            RegistryState::Retired => "retired",
            RegistryState::Compromised => "compromised",
            RegistryState::ReenrollmentRequired => "reenrollment_required",
        }
    }
    pub fn parse(s: &str) -> Option<RegistryState> {
        Some(match s {
            "pending" => RegistryState::Pending,
            "active" => RegistryState::Active,
            "revoked" => RegistryState::Revoked,
            "retired" => RegistryState::Retired,
            "compromised" => RegistryState::Compromised,
            "reenrollment_required" => RegistryState::ReenrollmentRequired,
            _ => return None,
        })
    }
    /// The one question the registry answers. Only `active` counts — and the states that do
    /// not are the interesting ones: pending (not yet), revoked/compromised (no longer,
    /// against its will), retired (no longer, by decision).
    pub fn is_usable(self) -> bool {
        matches!(self, RegistryState::Active)
    }
    /// §5 — revoked/retired/compromised are terminal. A device that came back from any of
    /// them would make the revocation a suggestion.
    pub fn is_terminal(self) -> bool {
        matches!(self, RegistryState::Revoked | RegistryState::Retired | RegistryState::Compromised)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceRecord {
    pub device_id: String,
    pub tenant_id: String,
    pub branch_id: String,
    pub install_id: String,
    pub device_public_key: String,
    pub device_role: String,
    pub capabilities: Vec<String>,
    pub protocol_min: i64,
    pub protocol_max: i64,
    pub state: RegistryState,
    pub active_certificate_serial: Option<String>,
}

const DEVICE_COLS: &str = "device_id, tenant_id, branch_id, install_id, device_public_key, \
     device_role, capabilities, protocol_min, protocol_max, state, active_certificate_serial";

fn device_from_row(r: &rusqlite::Row) -> rusqlite::Result<DeviceRecord> {
    let caps: String = r.get(6)?;
    let state: String = r.get(9)?;
    Ok(DeviceRecord {
        device_id: r.get(0)?,
        tenant_id: r.get(1)?,
        branch_id: r.get(2)?,
        install_id: r.get(3)?,
        device_public_key: r.get(4)?,
        device_role: r.get(5)?,
        capabilities: if caps.is_empty() {
            Vec::new()
        } else {
            caps.split('\u{1f}').map(|s| s.to_string()).collect()
        },
        protocol_min: r.get(7)?,
        protocol_max: r.get(8)?,
        // An unparseable state is NOT a permissive default.
        state: RegistryState::parse(&state).unwrap_or(RegistryState::Revoked),
        active_certificate_serial: r.get(10)?,
    })
}

/// Capabilities are stored as a unit-separator-joined string.
///
/// A separator that cannot occur in a capability name (validated: no control characters, and
/// `MAX_ID_LEN`-bounded) beats JSON here, because the column is only ever read back into the
/// same Vec — and a JSON blob invites someone to query into it later, which would make the
/// stored copy authoritative instead of the signed certificate.
fn join_caps(caps: &[String]) -> String {
    caps.join("\u{1f}")
}

pub fn load_device(conn: &Connection, device_id: &str) -> Result<Option<DeviceRecord>, &'static str> {
    conn.query_row(
        &format!("SELECT {DEVICE_COLS} FROM enrolled_devices WHERE device_id = ?1"),
        params![device_id],
        device_from_row,
    )
    .optional()
    .map_err(|_| ERR_CERT_INVALID)
}

pub fn load_device_by_key(
    conn: &Connection,
    tenant_id: &str,
    public_key: &str,
) -> Result<Option<DeviceRecord>, &'static str> {
    conn.query_row(
        &format!(
            "SELECT {DEVICE_COLS} FROM enrolled_devices
              WHERE tenant_id = ?1 AND device_public_key = ?2"
        ),
        params![tenant_id, public_key],
        device_from_row,
    )
    .optional()
    .map_err(|_| ERR_CERT_INVALID)
}

/// §4 — the registry's verdict on a certificate serial.
///
/// A certificate verifying cryptographically is necessary and NOT sufficient: revocation is
/// a database fact, not a mathematical one, and a revoked certificate verifies perfectly
/// forever. This is the function that remembers that.
pub fn certificate_status(
    conn: &Connection,
    certificate_serial: &str,
) -> Result<Option<String>, &'static str> {
    conn.query_row(
        "SELECT status FROM device_certificates WHERE certificate_serial = ?1",
        params![certificate_serial],
        |r| r.get(0),
    )
    .optional()
    .map_err(|_| ERR_CERT_INVALID)
}

/// What the owner grants. Deliberately a separate type from the request: the request says
/// what the device *asked for*, this says what the owner *decided*, and letting one struct
/// be both is how "requested" quietly becomes "granted".
pub struct EnrollmentGrant<'a> {
    pub tenant_id: &'a str,
    pub branch_id: &'a str,
    pub device_role: &'a str,
    pub capabilities: &'a [String],
    pub protocol_min: i64,
    pub protocol_max: i64,
    pub device_label: Option<&'a str>,
}

/// §7 — the owner approves an enrollment request and the authority signs a certificate.
///
/// Everything the device asked for is advisory. The owner decides tenant, branch, role,
/// capabilities and protocol range; nothing from the request is copied into the grant
/// without passing through this argument. That asymmetry is the whole security property:
/// a self-signed request that could grant its own role would be a device promoting itself.
#[allow(clippy::too_many_arguments)]
pub fn approve_enrollment(
    conn: &Connection,
    req: &EnrollmentRequest,
    grant: &EnrollmentGrant,
    root: &TrustRootRecord,
    key: &RootKey,
    authority_id: &str,
    authority_epoch: i64,
    // §7 — the root-signed authority certificate (verbatim JSON) that the response carries so
    // the target can verify the chain from a root it does not yet know.
    authority_certificate_json: &str,
    owner: &OwnerAuth,
) -> Result<(DeviceCertificate, EnrollmentResponse), &'static str> {
    // D7 — proof of possession, before anything else is considered.
    req.verify_self_signature()?;

    // The request's own claims about tenant/branch are NOT trusted; the grant decides. But a
    // request asking for a different tenant than the owner is granting is a mismatch worth
    // naming rather than silently overriding.
    if req.requested_tenant_id != grant.tenant_id {
        return Err(ERR_TENANT_MISMATCH);
    }
    if req.requested_branch_id != grant.branch_id {
        return Err(ERR_BRANCH_MISMATCH);
    }
    if grant.protocol_min < 1 || grant.protocol_max < grant.protocol_min {
        return Err(ERR_REQUEST_INVALID);
    }
    if grant.capabilities.len() > MAX_CAPABILITIES {
        return Err(ERR_REQUEST_INVALID);
    }
    for c in grant.capabilities {
        // The unit separator is the storage delimiter; a capability containing it would
        // split into two on read-back.
        if c.is_empty() || c.len() > MAX_ID_LEN || c.contains('\u{1f}') {
            return Err(ERR_REQUEST_INVALID);
        }
    }
    if grant.device_label.is_some_and(|l| l.len() > MAX_LABEL_LEN) {
        return Err(ERR_REQUEST_INVALID);
    }
    if !root.state.may_sign() {
        return Err(ERR_CERT_SIGNATURE);
    }

    // A public key already belonging to another device is refused. The unique index is the
    // real guard; this is the legible error.
    if let Some(existing) = load_device_by_key(conn, grant.tenant_id, &req.device_public_key)? {
        if existing.device_id != req.device_id {
            return Err(ERR_CONFLICT);
        }
        // Same device re-enrolling into a terminal state is not an enrollment.
        if existing.state.is_terminal() {
            return Err(ERR_CONFLICT);
        }
    }
    // …and an existing device row must agree about the install binding.
    if let Some(existing) = load_device(conn, &req.device_id)? {
        if existing.install_id != req.install_id
            || existing.device_public_key != req.device_public_key
        {
            // §5 — install_id and public key are not silently overwritten after enrollment.
            return Err(ERR_CONFLICT);
        }
        if existing.state.is_terminal() {
            return Err(ERR_CONFLICT);
        }
    }

    let now = chrono::Utc::now().to_rfc3339();
    let previous = load_device(conn, &req.device_id)?.and_then(|d| d.active_certificate_serial);

    let payload = DeviceCertificatePayload {
        format_version: CERTIFICATE_VERSION,
        tenant_id: grant.tenant_id.to_string(),
        branch_id: grant.branch_id.to_string(),
        device_id: req.device_id.clone(),
        // Straight from the request — but the request proved possession of the key, and the
        // install id is what makes a copied certificate useless elsewhere (D12).
        install_id: req.install_id.clone(),
        device_public_key: req.device_public_key.clone(),
        device_role: grant.device_role.to_string(),
        capabilities: grant.capabilities.to_vec(),
        protocol_min: grant.protocol_min,
        protocol_max: grant.protocol_max,
        certificate_serial: uuid::Uuid::new_v4().to_string(),
        authority_id: authority_id.to_string(),
        authority_epoch,
        root_key_id: root.root_key_id.clone(),
        root_generation: root.generation,
        issued_at: now.clone(),
        previous_certificate_serial: previous.clone(),
    };
    use base64::Engine;
    let cert = DeviceCertificate {
        signature: base64::engine::general_purpose::STANDARD.encode(key.sign(&payload.canonical())),
        payload,
    };
    cert.validate_structure()?;

    let cert_json = cert.to_json()?;
    let serial = cert.payload.certificate_serial.clone();

    let tx = conn.unchecked_transaction().map_err(|_| ERR_CERT_INVALID)?;
    // Supersede the old certificate first: the partial unique index allows exactly one
    // active row per device, so the other order collides with itself.
    if let Some(prev) = &previous {
        tx.execute(
            "UPDATE device_certificates SET status = 'superseded'
              WHERE certificate_serial = ?1 AND status = 'active'",
            params![prev],
        )
        .map_err(|_| ERR_CERT_INVALID)?;
        tx.execute(
            "INSERT OR IGNORE INTO device_revocations
               (device_id, certificate_serial, tenant_id, reason_code, reason, revoked_at, revoked_by)
             VALUES (?1, ?2, ?3, 'reenrolled', 'superseded by re-enrollment', ?4, ?5)",
            params![req.device_id, prev, grant.tenant_id, now, owner.user_id()],
        )
        .map_err(|_| ERR_CERT_INVALID)?;
    }

    tx.execute(
        "INSERT INTO enrolled_devices
           (device_id, tenant_id, branch_id, install_id, device_public_key, device_label,
            device_role, capabilities, protocol_min, protocol_max, state,
            active_certificate_serial, created_at, enrolled_at, created_by)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'active',?11,?12,?12,?13)
         ON CONFLICT(device_id) DO UPDATE SET
            device_label = excluded.device_label,
            device_role = excluded.device_role,
            capabilities = excluded.capabilities,
            protocol_min = excluded.protocol_min,
            protocol_max = excluded.protocol_max,
            state = 'active',
            active_certificate_serial = excluded.active_certificate_serial,
            enrolled_at = excluded.enrolled_at",
        params![
            req.device_id,
            grant.tenant_id,
            grant.branch_id,
            req.install_id,
            req.device_public_key,
            grant.device_label,
            grant.device_role,
            join_caps(grant.capabilities),
            grant.protocol_min,
            grant.protocol_max,
            serial,
            now,
            owner.user_id(),
        ],
    )
    .map_err(|_| ERR_CONFLICT)?;

    tx.execute(
        "INSERT INTO device_certificates
           (certificate_serial, device_id, tenant_id, branch_id, install_id, device_public_key,
            authority_id, authority_epoch, root_key_id, root_generation, certificate,
            payload_hash, previous_certificate_serial, status, issued_at, issued_by, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'active',?14,?15,?14)",
        params![
            serial,
            req.device_id,
            grant.tenant_id,
            grant.branch_id,
            req.install_id,
            req.device_public_key,
            authority_id,
            authority_epoch,
            root.root_key_id,
            root.generation,
            cert_json,
            cert.payload.payload_hash(),
            previous,
            now,
            owner.user_id(),
        ],
    )
    .map_err(|_| ERR_CONFLICT)?;

    // The request is recorded as decided. `request_hash` is uniquely indexed, so replaying
    // a different request that reuses a nonce fails here rather than minting a second
    // certificate.
    tx.execute(
        "INSERT INTO device_enrollment_requests
           (request_id, device_id, install_id, device_public_key, request_hash,
            requested_tenant_id, requested_branch_id, requested_role, requested_capabilities,
            protocol_min, protocol_max, state, issued_certificate_serial, created_at,
            imported_at, decided_at, decided_by)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'approved',?12,?13,?14,?14,?15)
         ON CONFLICT(request_id) DO UPDATE SET
            state = 'approved',
            issued_certificate_serial = excluded.issued_certificate_serial,
            decided_at = excluded.decided_at,
            decided_by = excluded.decided_by",
        params![
            req.request_id,
            req.device_id,
            req.install_id,
            req.device_public_key,
            req.request_hash(),
            req.requested_tenant_id,
            req.requested_branch_id,
            req.requested_role,
            join_caps(&req.requested_capabilities),
            req.protocol_min,
            req.protocol_max,
            serial,
            req.created_at,
            now,
            owner.user_id(),
        ],
    )
    .map_err(|_| ERR_CONFLICT)?;

    tx.commit().map_err(|_| ERR_CERT_INVALID)?;

    let record_hash = registry_record_hash(conn, &req.device_id)?;

    // §7 — the signed approval. It binds the entire grant to the request it answers, signed by
    // the same root the device/authority certificates hang from (the active authority holds and
    // uses the root key). The target verifies it against its LOCAL request, its device key, the
    // device certificate and the registry hash — so none of those response fields is trusted on
    // its own any more.
    let approval_payload = DeviceEnrollmentApprovalPayload {
        format_version: IDENTITY_FORMAT_VERSION,
        request_id: req.request_id.clone(),
        request_nonce: req.request_nonce.clone(),
        device_id: req.device_id.clone(),
        install_id: req.install_id.clone(),
        device_public_key: req.device_public_key.clone(),
        tenant_id: grant.tenant_id.to_string(),
        branch_id: grant.branch_id.to_string(),
        granted_role: grant.device_role.to_string(),
        granted_capabilities: grant.capabilities.to_vec(),
        protocol_min: grant.protocol_min,
        protocol_max: grant.protocol_max,
        device_certificate_serial: serial.clone(),
        device_certificate_hash: cert.payload.payload_hash(),
        registry_record_hash: record_hash.clone(),
        issued_at: now.clone(),
    };
    let approval = DeviceEnrollmentApproval {
        signature: base64::engine::general_purpose::STANDARD
            .encode(key.sign(&approval_payload.canonical())),
        payload: approval_payload,
    };
    approval.validate_structure()?;
    let approval_json = approval.to_json()?;

    let response = EnrollmentResponse {
        format_version: IDENTITY_FORMAT_VERSION,
        purpose: PURPOSE_RESPONSE.to_string(),
        request_id: req.request_id.clone(),
        device_id: req.device_id.clone(),
        install_id: req.install_id.clone(),
        // §7 — the whole chain travels: root, authority cert, device cert, signed approval.
        tenant_root_public_key: root.public_key.clone(),
        tenant_root_fingerprint: root.fingerprint.clone(),
        authority_certificate: authority_certificate_json.to_string(),
        device_certificate: cert_json,
        approval: approval_json,
        registry_record_hash: record_hash,
        issued_at: now,
    };
    Ok((cert, response))
}

/// SHA-256 over the canonical registry row. Lets a device notice that the row it was told
/// about is not the row that was written. Not a security boundary — the certificate's
/// signature is.
pub fn registry_record_hash(conn: &Connection, device_id: &str) -> Result<String, &'static str> {
    let d = load_device(conn, device_id)?.ok_or(ERR_CERT_INVALID)?;
    let mut w = CanonicalWriter::new(canonical::DOMAIN_DEVICE_CERT, CERTIFICATE_VERSION);
    w.string(&d.device_id)
        .string(&d.tenant_id)
        .string(&d.branch_id)
        .string(&d.install_id)
        .string(&d.device_public_key)
        .string(&d.device_role);
    w.i64(d.capabilities.len() as i64);
    for c in &d.capabilities {
        w.string(c);
    }
    w.i64(d.protocol_min)
        .i64(d.protocol_max)
        .string(d.state.as_str())
        .opt_string(d.active_certificate_serial.as_deref());
    Ok(canonical::sha256_hex(&w.finish()))
}

// ── §9 — revocation, retirement, re-enrollment ──────────────────────────────

/// Why a device stopped being usable. The code is recorded, because "revoked" and
/// "compromised" call for different responses from a human.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevokeReason {
    Revoked,
    Retired,
    Compromised,
}

impl RevokeReason {
    fn code(self) -> &'static str {
        match self {
            RevokeReason::Revoked => "revoked",
            RevokeReason::Retired => "retired",
            RevokeReason::Compromised => "compromised",
        }
    }
    fn state(self) -> RegistryState {
        match self {
            RevokeReason::Revoked => RegistryState::Revoked,
            RevokeReason::Retired => RegistryState::Retired,
            RevokeReason::Compromised => RegistryState::Compromised,
        }
    }
}

/// §9 — owner-authorized end of a device's life. Terminal in all three flavours.
///
/// D18 — retirement is irreversible, and so are the other two. There is deliberately no
/// `un_revoke`: a device that can come back from revocation makes revocation a suggestion.
/// The way back is a NEW enrollment with a NEW keypair, which is a different device.
pub fn revoke_device(
    conn: &Connection,
    device_id: &str,
    reason: RevokeReason,
    note: Option<&str>,
    owner: &OwnerAuth,
) -> Result<(), &'static str> {
    let d = load_device(conn, device_id)?.ok_or(ERR_DEVICE_MISMATCH)?;
    if d.state.is_terminal() {
        // Idempotent for the same reason; a different terminal state is a contradiction.
        return if d.state == reason.state() { Ok(()) } else { Err(ERR_CONFLICT) };
    }
    let now = chrono::Utc::now().to_rfc3339();
    let tx = conn.unchecked_transaction().map_err(|_| ERR_CERT_INVALID)?;

    let (ts_col, who_col) = match reason {
        RevokeReason::Retired => ("retired_at", "retired_by"),
        _ => ("revoked_at", "revoked_by"),
    };
    // Column names come from this match, never from a caller's string.
    tx.execute(
        &format!(
            "UPDATE enrolled_devices
                SET state = ?2, {ts_col} = ?3, {who_col} = ?4, active_certificate_serial = NULL
              WHERE device_id = ?1"
        ),
        params![device_id, reason.state().as_str(), now, owner.user_id()],
    )
    .map_err(|_| ERR_CERT_INVALID)?;

    if let Some(serial) = &d.active_certificate_serial {
        tx.execute(
            "UPDATE device_certificates SET status = ?2, revoked_at = ?3
              WHERE certificate_serial = ?1",
            params![serial, reason.code(), now],
        )
        .map_err(|_| ERR_CERT_INVALID)?;
        tx.execute(
            "INSERT OR IGNORE INTO device_revocations
               (device_id, certificate_serial, tenant_id, reason_code, reason, revoked_at, revoked_by)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![device_id, serial, d.tenant_id, reason.code(), note, now, owner.user_id()],
        )
        .map_err(|_| ERR_CERT_INVALID)?;
    }
    tx.commit().map_err(|_| ERR_CERT_INVALID)?;
    Ok(())
}

/// §9 — the owner declares that a device must re-enroll (e.g. it lost its key).
///
/// Distinct from revocation: the device is not being punished, it is being asked to come
/// back with a new keypair. Its old certificate stops being active either way — there is no
/// "silent key rotation", because the old certificate names a public key nobody holds.
pub fn begin_reenrollment(
    conn: &Connection,
    device_id: &str,
    owner: &OwnerAuth,
) -> Result<(), &'static str> {
    let d = load_device(conn, device_id)?.ok_or(ERR_DEVICE_MISMATCH)?;
    if d.state.is_terminal() {
        return Err(ERR_CONFLICT);
    }
    let now = chrono::Utc::now().to_rfc3339();
    let tx = conn.unchecked_transaction().map_err(|_| ERR_CERT_INVALID)?;
    tx.execute(
        "UPDATE enrolled_devices
            SET state = 'reenrollment_required', active_certificate_serial = NULL
          WHERE device_id = ?1",
        params![device_id],
    )
    .map_err(|_| ERR_CERT_INVALID)?;
    if let Some(serial) = &d.active_certificate_serial {
        tx.execute(
            "UPDATE device_certificates SET status = 'superseded' WHERE certificate_serial = ?1",
            params![serial],
        )
        .map_err(|_| ERR_CERT_INVALID)?;
        tx.execute(
            "INSERT OR IGNORE INTO device_revocations
               (device_id, certificate_serial, tenant_id, reason_code, reason, revoked_at, revoked_by)
             VALUES (?1,?2,?3,'reenrolled','owner started re-enrollment',?4,?5)",
            params![device_id, serial, d.tenant_id, now, owner.user_id()],
        )
        .map_err(|_| ERR_CERT_INVALID)?;
    }
    tx.commit().map_err(|_| ERR_CERT_INVALID)?;
    Ok(())
}

// ── §8 — the local, never-synced trust anchor ───────────────────────────────

/// The pinned tenant root. Public content, security-critical role: every re-import is checked
/// against it. It lives beside the device key in AppData and is NEVER a synced row — pinning a
/// root that then travelled over the wire would defeat the entire point of pinning it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TrustAnchor {
    pub format_version: u32,
    pub tenant_id: String,
    /// §5 — the branch is part of the pinned identity. A root is pinned FOR a tenant/branch;
    /// without this, a response bearing the right root fingerprint but a different branch would
    /// pass `same_root` (A10). Added in B2DE2.
    pub branch_id: String,
    pub root_key_id: String,
    pub root_public_key: String,
    pub root_fingerprint: String,
    pub root_generation: i64,
    pub pinned_at: String,
}

fn anchor_path(dir: &Path) -> std::path::PathBuf {
    dir.join(TRUST_ANCHOR_FILENAME)
}

pub fn trust_anchor_exists(dir: &Path) -> bool {
    anchor_path(dir).exists()
}

pub fn load_trust_anchor(dir: &Path) -> Result<Option<TrustAnchor>, &'static str> {
    match std::fs::read_to_string(anchor_path(dir)) {
        Ok(raw) => {
            let a: TrustAnchor =
                serde_json::from_str(&raw).map_err(|_| ERR_ANCHOR_INVALID)?;
            // §5 — hard, exact bounds; no silent defaults. `deny_unknown_fields` already
            // rejected anything with extra keys; these reject anything with wrong-shaped values.
            use base64::Engine;
            let pubkey_ok = a.root_public_key.len() == PUBLIC_KEY_B64_LEN
                && base64::engine::general_purpose::STANDARD
                    .decode(&a.root_public_key)
                    .map(|b| b.len() == 32)
                    .unwrap_or(false);
            let fp_ok = a.root_fingerprint.len() == FINGERPRINT_HEX_LEN
                && a.root_fingerprint.bytes().all(|c| c.is_ascii_hexdigit());
            let ids_ok = [&a.tenant_id, &a.branch_id, &a.root_key_id]
                .iter()
                .all(|s| !s.is_empty() && s.len() <= MAX_ID_LEN);
            if a.format_version != IDENTITY_FORMAT_VERSION
                || !pubkey_ok
                || !fp_ok
                || !ids_ok
                || a.root_generation < 1
                || a.pinned_at.is_empty()
                || a.pinned_at.len() > MAX_TIMESTAMP_LEN
            {
                return Err(ERR_ANCHOR_INVALID);
            }
            Ok(Some(a))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(ERR_ANCHOR_INVALID),
    }
}

/// Write the anchor once, atomically. Same tmp + `hard_link` publication as the device key:
/// an anchor half-written is an anchor that could be read empty, and a root is exactly the
/// thing that must never be read as "not there yet".
fn write_trust_anchor(dir: &Path, anchor: &TrustAnchor) -> Result<(), &'static str> {
    use std::io::Write;
    let path = anchor_path(dir);
    let body = serde_json::to_string_pretty(anchor).map_err(|_| ERR_ANCHOR_INVALID)?;
    let tmp = dir.join(format!(".{TRUST_ANCHOR_FILENAME}.{}.tmp", uuid::Uuid::new_v4().as_simple()));
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|_| ERR_ANCHOR_INVALID)?;
        f.write_all(body.as_bytes()).map_err(|_| ERR_ANCHOR_INVALID)?;
        f.sync_all().map_err(|_| ERR_ANCHOR_INVALID)?;
    }
    let published = std::fs::hard_link(&tmp, &path);
    let _ = std::fs::remove_file(&tmp);
    match published {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(_) => Err(ERR_ANCHOR_INVALID),
    }
}

/// §5 — the anchor and a response describe the same pinned root iff ALL six identifying fields
/// match: tenant, branch, root key id, generation, public key, fingerprint. Miss any one and it
/// is a different root (or the same root claimed for a different tenant/branch) — refused.
#[allow(clippy::too_many_arguments)]
fn same_root(
    a: &TrustAnchor,
    tenant: &str,
    branch: &str,
    root_key_id: &str,
    pubkey: &str,
    fp: &str,
    gen: i64,
) -> bool {
    a.tenant_id == tenant
        && a.branch_id == branch
        && a.root_key_id == root_key_id
        && a.root_public_key == pubkey
        && a.root_fingerprint == fp
        && a.root_generation == gen
}

/// §5 — the "later certificate check": re-verify the STORED device certificate against the
/// PINNED anchor, comparing the same six identifying fields the import compared, then the
/// signature against the anchor's pinned public key. This is the primitive any post-import
/// caller uses to trust the local certificate again (B3's sync path will); keeping it here
/// means "compare against the anchor" is written once, not re-derived per call site.
pub fn verify_certificate_against_anchor(dir: &Path) -> Result<(), &'static str> {
    let anchor = load_trust_anchor(dir)?.ok_or(ERR_ANCHOR_INVALID)?;
    let cert = load_certificate(dir)?;
    // The certificate must name the tenant/branch/root/generation the anchor pins. The cert
    // carries no root public key of its own — the anchor's is the authority.
    if cert.payload.tenant_id != anchor.tenant_id
        || cert.payload.branch_id != anchor.branch_id
        || cert.payload.root_key_id != anchor.root_key_id
        || cert.payload.root_generation != anchor.root_generation
    {
        return Err(ERR_ANCHOR_CONFLICT);
    }
    let root = TrustRootRecord {
        tenant_id: anchor.tenant_id.clone(),
        root_key_id: anchor.root_key_id.clone(),
        public_key: anchor.root_public_key.clone(),
        fingerprint: anchor.root_fingerprint.clone(),
        generation: anchor.root_generation,
        state: trust_root::RootState::Active,
    };
    verify_certificate(
        &cert,
        &DeviceVerifyContext {
            tenant_id: &anchor.tenant_id,
            branch_id: &anchor.branch_id,
            root: &root,
            expect_install_id: None,
            expect_public_key: None,
        },
    )
}

// ── §8 — importing the response, on the device ──────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnrollOutcome {
    Enrolled,
    /// Byte-identical re-import (D15).
    AlreadyEnrolled,
}

/// §7/§8 — the device adopts its certificate, pinning the tenant root out-of-band.
///
/// This is the heart of B2DE1. The old import trusted a root the CALLER already held; the new
/// one receives the whole chain in the response and refuses to trust it on internal
/// consistency alone (E3: an attacker can forge an internally perfect chain with the right
/// tenant strings). What breaks the attack is `expected_root_fingerprint` — 64 hex characters
/// the owner confirms through a SEPARATE channel (a QR code from the primary, a phone call, a
/// side-by-side read). On a first import it is mandatory and must equal the response's root
/// fingerprint; after that the pinned anchor is the authority and a contradicting root is
/// refused fail-closed.
///
/// The order matters: the fingerprint gate comes BEFORE any signature maths, because verifying
/// a forged chain and then rejecting it still means we processed attacker input as if it might
/// be ours. The anchor decision is made first, and everything after hangs off the pinned root.
///
/// It does NOT claim primary, start a server, or touch the LAN mode. A certificate arriving is
/// not a machine becoming anything.
pub fn import_enrollment_response(
    dir: &Path,
    raw: &str,
    install_id: &str,
    expected_root_fingerprint: Option<&str>,
    expected_request_id: Option<&str>,
) -> Result<EnrollOutcome, &'static str> {
    let resp = EnrollmentResponse::from_json(raw)?;
    let key = load_identity(dir)?;

    if let Some(req_id) = expected_request_id {
        if resp.request_id != req_id {
            return Err(ERR_RESPONSE_INVALID);
        }
    }
    if resp.device_id != key.device_id() {
        return Err(ERR_DEVICE_MISMATCH);
    }
    if resp.install_id != install_id {
        return Err(ERR_INSTALL_MISMATCH);
    }

    // §8 — the root's fingerprint must be the real SHA-256 of its public key. An attacker who
    // supplies a mismatched pair is trying to have the pin check one value and the signature
    // check another; refuse before either.
    use base64::Engine;
    let root_pub_bytes = base64::engine::general_purpose::STANDARD
        .decode(&resp.tenant_root_public_key)
        .map_err(|_| ERR_RESPONSE_INVALID)?;
    if trust_root::fingerprint_of(&root_pub_bytes) != resp.tenant_root_fingerprint {
        return Err(ERR_RESPONSE_INVALID);
    }

    // §8 — the anchor decision, made BEFORE any certificate is verified.
    let existing_anchor = load_trust_anchor(dir)?;
    // The chain must agree on which root it hangs from; take the root_key_id/generation from
    // the device certificate (verified below) but read them now for the anchor comparison.
    let dcert = DeviceCertificate::from_json(&resp.device_certificate)?;
    let root_key_id = dcert.payload.root_key_id.clone();
    let root_generation = dcert.payload.root_generation;

    match &existing_anchor {
        Some(anchor) => {
            // Re-import: the pinned anchor is the authority. A response naming any other root —
            // OR the same root claimed for a different branch — is refused. No silent root
            // replacement, ever.
            if !same_root(
                anchor,
                &dcert.payload.tenant_id,
                &dcert.payload.branch_id,
                &root_key_id,
                &resp.tenant_root_public_key,
                &resp.tenant_root_fingerprint,
                root_generation,
            ) {
                return Err(ERR_ANCHOR_CONFLICT);
            }
            // If the caller ALSO passed a fingerprint, it must not contradict the anchor.
            if let Some(fp) = expected_root_fingerprint {
                if fp != anchor.root_fingerprint {
                    return Err(ERR_ROOT_FINGERPRINT_MISMATCH);
                }
            }
        }
        None => {
            // First import: the out-of-band fingerprint is mandatory. This is the one moment
            // the target has no prior knowledge of the root, so the human-confirmed value is
            // the only thing standing between it and an attacker's forged chain.
            let fp = expected_root_fingerprint.ok_or(ERR_ROOT_FINGERPRINT_REQUIRED)?;
            if fp.len() != FINGERPRINT_HEX_LEN {
                return Err(ERR_ROOT_FINGERPRINT_MISMATCH);
            }
            if fp != resp.tenant_root_fingerprint {
                return Err(ERR_ROOT_FINGERPRINT_MISMATCH);
            }
        }
    }

    // The root is now trusted (pinned or confirmed). Build the record every signature is
    // checked against — its public key is the confirmed one, not one we were merely handed.
    let root = TrustRootRecord {
        tenant_id: dcert.payload.tenant_id.clone(),
        root_key_id: root_key_id.clone(),
        public_key: resp.tenant_root_public_key.clone(),
        fingerprint: resp.tenant_root_fingerprint.clone(),
        generation: root_generation,
        state: trust_root::RootState::Active,
    };

    // §7 — the authority certificate: root-signed, same tenant/branch/root as the chain, and
    // naming the authority the device certificate claims to descend from.
    let acert = super::authority::AuthorityCertificate::from_json(&resp.authority_certificate)
        .map_err(|_| ERR_AUTHORITY_CERT_INVALID)?;
    super::authority::verify_certificate(
        &acert,
        &super::authority::VerifyContext {
            tenant_id: &dcert.payload.tenant_id,
            branch_id: &dcert.payload.branch_id,
            root: &root,
            expect_instance: None,
        },
    )
    .map_err(|_| ERR_AUTHORITY_CERT_INVALID)?;
    // The device cert must descend from THAT authority, at THAT epoch.
    if dcert.payload.authority_id != acert.payload.authority_id
        || dcert.payload.authority_epoch != acert.payload.authority_epoch
    {
        return Err(ERR_AUTHORITY_CERT_INVALID);
    }

    // §7 — the device certificate: root-signed, binding THIS install and THIS key.
    verify_certificate(
        &dcert,
        &DeviceVerifyContext {
            tenant_id: &dcert.payload.tenant_id,
            branch_id: &dcert.payload.branch_id,
            root: &root,
            expect_install_id: Some(install_id),
            expect_public_key: Some(&key.public_key_b64()),
        },
    )?;
    if dcert.payload.device_id != key.device_id() {
        return Err(ERR_DEVICE_MISMATCH);
    }

    // §7 — the signed approval closes the "unsigned response metadata" gap. Load the LOCAL
    // request (the one THIS device made and persisted before any response existed) and verify
    // the approval against it, this device's key + install, the device certificate, and the
    // registry hash. A signed-approval response with no local request to answer is refused
    // fail-closed — we cannot prove it answers a request WE made.
    let local_request = load_enrollment_request(dir)?.ok_or(ERR_REQUEST_MISSING)?;
    let approval = DeviceEnrollmentApproval::from_json(&resp.approval)?;
    approval.verify(
        &root,
        &local_request,
        &key.public_key_b64(),
        install_id,
        &dcert,
        &resp.registry_record_hash,
    )?;

    // Everything verified. Pin the anchor on a first import (idempotent if it already matches),
    // then store the certificate. Anchor first: if the process dies between the two, a retry
    // finds the anchor and re-verifies against it — the safe order.
    if existing_anchor.is_none() {
        let anchor = TrustAnchor {
            format_version: IDENTITY_FORMAT_VERSION,
            tenant_id: root.tenant_id.clone(),
            branch_id: dcert.payload.branch_id.clone(),
            root_key_id: root.root_key_id.clone(),
            root_public_key: root.public_key.clone(),
            root_fingerprint: root.fingerprint.clone(),
            root_generation: root.generation,
            pinned_at: chrono::Utc::now().to_rfc3339(),
        };
        write_trust_anchor(dir, &anchor)?;
    }

    // D15/D16 — decide idempotence BEFORE writing.
    let already = matches!(
        load_certificate(dir),
        Ok(existing) if existing.payload.certificate_serial == dcert.payload.certificate_serial
    );
    store_certificate(dir, &dcert)?;
    Ok(if already { EnrollOutcome::AlreadyEnrolled } else { EnrollOutcome::Enrolled })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::primary::{self, State};

    const INSTALL_A: &str = "11111111-1111-4111-8111-111111111111";
    const INSTALL_B: &str = "22222222-2222-4222-8222-222222222222";
    const OWNER_PW: &str = "owner-password-1234";

    /// A temp dir that removes itself on drop, panic included. These hold real Ed25519
    /// device keys; cleanup at the end of a test body does not run when an assertion fails.
    struct TempDir(std::path::PathBuf);
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
    fn tmp_dir() -> TempDir {
        let d = std::env::temp_dir()
            .join(format!("com.lataif.m6b2dtest-{}", uuid::Uuid::new_v4().as_simple()));
        std::fs::create_dir_all(&d).unwrap();
        TempDir(d)
    }

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
             INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','B','n','n');
             INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-two','tenant-1','C','n','n');",
        )
        .unwrap();
        lataif_server::migrations::run_migrations(&conn, crate::sync::migrations::EMBEDDED_MIGRATIONS)
            .unwrap();
        conn
    }

    /// A provisioned owner — through the real `provision_owner`, never a hand-written row.
    fn owner(conn: &Connection) -> primary::OwnerAuth {
        let hash = bcrypt::hash("placeholder", 4).unwrap();
        conn.execute(
            "INSERT INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at)
             VALUES ('user-owner','tenant-1','owner@x.com',?1,'O',1,'n','n')",
            params![hash],
        )
        .unwrap();
        conn.execute_batch("INSERT INTO user_branches VALUES ('user-owner','branch-main','owner',1,'n');")
            .unwrap();
        crate::sync::credentials::provision_owner(
            conn,
            OWNER_PW,
            OWNER_PW,
            crate::sync::credentials::PROVISION_CONFIRMATION,
        )
        .unwrap();
        primary::authorize_owner(conn, "tenant-1", "branch-main", "owner@x.com", OWNER_PW).unwrap()
    }

    /// A primary with a trust root and an authority — what a real enrolling server is.
    struct Server {
        conn: Connection,
        dir: TempDir,
        owner: primary::OwnerAuth,
        root: TrustRootRecord,
        authority_id: String,
        authority_epoch: i64,
        authority_cert_json: String,
    }

    fn server() -> Server {
        let conn = db();
        let o = owner(&conn);
        let dir = tmp_dir();
        trust_root::initialize_root(&conn, &dir, "tenant-1", INSTALL_A, State::Primary, &o).unwrap();
        let root = trust_root::load_active_root(&conn, "tenant-1").unwrap().unwrap();
        let key = trust_root::load_key(&dir, &root).unwrap();
        let cert = crate::sync::authority::initialize_authority(
            &crate::sync::authority::IssueContext {
                conn: &conn,
                tenant_id: "tenant-1",
                branch_id: "branch-main",
                install_id: INSTALL_A,
                primary_state: State::Primary,
                root: &root,
                key: &key,
                owner: &o,
            },
        )
        .unwrap();
        let (aid, ep) = (cert.payload.authority_id.clone(), cert.payload.authority_epoch);
        let acert_json = cert.to_json().unwrap();
        drop(key);
        Server {
            conn,
            dir,
            owner: o,
            root,
            authority_id: aid,
            authority_epoch: ep,
            authority_cert_json: acert_json,
        }
    }

    impl Server {
        fn key(&self) -> RootKey {
            trust_root::load_key(&self.dir, &self.root).unwrap()
        }
        /// The out-of-band fingerprint a target owner would confirm before importing.
        fn root_fp(&self) -> String {
            self.root.fingerprint.clone()
        }
        fn grant<'a>(&self, caps: &'a [String]) -> EnrollmentGrant<'a> {
            EnrollmentGrant {
                tenant_id: "tenant-1",
                branch_id: "branch-main",
                device_role: "client",
                capabilities: caps,
                protocol_min: 1,
                protocol_max: 3,
                device_label: Some("Counter PC"),
            }
        }
        fn approve(
            &self,
            req: &EnrollmentRequest,
        ) -> Result<(DeviceCertificate, EnrollmentResponse), &'static str> {
            let caps = vec!["sync".to_string()];
            approve_enrollment(
                &self.conn,
                req,
                &self.grant(&caps),
                &self.root,
                &self.key(),
                &self.authority_id,
                self.authority_epoch,
                &self.authority_cert_json,
                &self.owner,
            )
        }
    }

    fn device_request(dir: &Path, install: &str) -> (DeviceKey, EnrollmentRequest) {
        let key = create_identity(dir).unwrap();
        let req = create_enrollment_request(
            &key,
            install,
            "tenant-1",
            "branch-main",
            "client",
            &["sync".to_string()],
            1,
            3,
        )
        .unwrap();
        // §7 — persist it exactly as the production command does, so an import can check the
        // signed approval against the request THIS device actually made.
        store_enrollment_request(dir, &req).unwrap();
        (key, req)
    }

    // ── D1: two fresh devices get different keys ─────────────────────────────
    #[test]
    fn d1_two_fresh_devices_get_different_keys() {
        let (d1, d2) = (tmp_dir(), tmp_dir());
        let k1 = create_identity(&d1).unwrap();
        let k2 = create_identity(&d2).unwrap();
        assert_ne!(k1.public_key_b64(), k2.public_key_b64(), "keys must be random, never derived");
        assert_ne!(k1.device_id(), k2.device_id());
        assert_ne!(k1.fingerprint(), k2.fingerprint());
        // Ed25519 public keys are 32 bytes.
        use base64::Engine;
        assert_eq!(
            base64::engine::general_purpose::STANDARD.decode(k1.public_key_b64()).unwrap().len(),
            32
        );
        // …and they really sign.
        let sig = k1.sign(b"hello");
        assert!(trust_root::verify_signature(&k1.public_key_b64(), b"hello", &sig));
        assert!(!trust_root::verify_signature(&k2.public_key_b64(), b"hello", &sig), "not k2's");
    }

    // ── D2: key and device_id survive a restart ──────────────────────────────
    #[test]
    fn d2_identity_survives_a_restart() {
        let d = tmp_dir();
        let first = create_identity(&d).unwrap();
        let (id, pk, created) =
            (first.device_id().to_string(), first.public_key_b64(), first.created_at().to_string());
        drop(first); // ← the process "ends" here

        let again = load_identity(&d).unwrap();
        assert_eq!(again.device_id(), id, "the device id must come back from disk");
        assert_eq!(again.public_key_b64(), pk);
        assert_eq!(again.created_at(), created);

        // load_or_create must LOAD, never mint a second identity.
        let third = load_or_create_identity(&d).unwrap();
        assert_eq!(third.public_key_b64(), pk);
        // A second create is refused outright.
        assert_eq!(create_identity(&d).unwrap_err(), ERR_IDENTITY_EXISTS);
    }

    // ── D3: a damaged key file is fail-closed and never replaced ─────────────
    #[test]
    fn d3_corrupt_identity_fails_closed() {
        use base64::Engine;
        let d = tmp_dir();
        create_identity(&d).unwrap();
        let p = d.join(IDENTITY_FILENAME);

        for bad in [
            String::new(),
            "   \n".to_string(),
            "garbage".to_string(),
            format!("{IDENTITY_PREFIX}1\nversion=1\ndevice_id=x\ncreated_at=n\npublic_key=y\nseed=AAAA\n"),
            // right shape, all-zero seed: a valid Ed25519 seed mathematically, which is
            // exactly why it must be refused — every damaged install would share it.
            format!(
                "{IDENTITY_PREFIX}1\nversion=1\ndevice_id=x\ncreated_at=n\npublic_key=y\nseed={}\n",
                base64::engine::general_purpose::STANDARD.encode([0u8; 32])
            ),
            // unknown field = a format we have not reasoned about
            format!("{IDENTITY_PREFIX}1\nversion=1\nextra=1\n"),
            // wrong version
            format!("{IDENTITY_PREFIX}9\nversion=9\n"),
        ] {
            std::fs::write(&p, &bad).unwrap();
            assert_eq!(load_identity(&d).unwrap_err(), ERR_IDENTITY_INVALID, "input {bad:?}");
            // …and the damaged file is NEVER silently regenerated.
            assert_eq!(std::fs::read_to_string(&p).unwrap(), bad, "must not self-heal");
            assert_eq!(load_or_create_identity(&d).unwrap_err(), ERR_IDENTITY_INVALID);
            assert_eq!(resolve_state(&d), DeviceState::IdentityCorrupt);
        }
    }

    // ── D4: certificate without key → reenrollment_required ──────────────────
    #[test]
    fn d4_certificate_without_key_requires_reenrollment() {
        let s = server();
        let d = tmp_dir();
        let (_key, req) = device_request(&d, INSTALL_B);
        let (cert, _resp) = s.approve(&req).unwrap();
        store_certificate(&d, &cert).unwrap();
        assert_eq!(resolve_state(&d), DeviceState::Enrolled);

        // The key file is lost — a restore that missed it, a disk fault, a careless cleanup.
        std::fs::remove_file(d.join(IDENTITY_FILENAME)).unwrap();

        assert_eq!(
            resolve_state(&d),
            DeviceState::ReenrollmentRequired,
            "a certificate whose private key is gone can never prove possession again"
        );
        assert!(!resolve_state(&d).can_prove_possession());
        // And the machine must NOT quietly mint a new keypair under the old certificate.
        assert_eq!(
            create_identity(&d).unwrap_err(),
            ERR_REENROLLMENT_REQUIRED,
            "no silent re-keying where a certificate ever existed"
        );
        assert_eq!(load_or_create_identity(&d).unwrap_err(), ERR_REENROLLMENT_REQUIRED);
        assert!(!identity_exists(&d), "must not have invented a replacement");
    }

    // ── D5: key without certificate → unenrolled ─────────────────────────────
    #[test]
    fn d5_key_without_certificate_is_unenrolled() {
        let d = tmp_dir();
        assert_eq!(resolve_state(&d), DeviceState::IdentityMissing);
        create_identity(&d).unwrap();
        assert_eq!(resolve_state(&d), DeviceState::Unenrolled);
        assert!(!resolve_state(&d).can_prove_possession(), "a key alone proves nothing about role");
        assert_eq!(load_certificate(&d).unwrap_err(), ERR_CERT_MISSING);
    }

    // ── D6/D7: the request is signed, and tampering breaks it ────────────────
    #[test]
    fn d6_d7_request_is_signed_and_tamper_evident() {
        let d = tmp_dir();
        let (key, req) = device_request(&d, INSTALL_B);

        // D6 — it verifies against the key the request itself carries.
        assert!(req.verify_self_signature().is_ok());
        assert_eq!(req.device_public_key, key.public_key_b64());
        assert_eq!(req.purpose, PURPOSE_REQUEST);

        // D7 — every signed field is covered.
        let mutations: Vec<fn(&mut EnrollmentRequest)> = vec![
            |r: &mut EnrollmentRequest| r.install_id = INSTALL_A.into(),
            |r: &mut EnrollmentRequest| r.requested_role = "owner".into(),
            |r: &mut EnrollmentRequest| r.requested_tenant_id = "tenant-2".into(),
            |r: &mut EnrollmentRequest| r.requested_capabilities = vec!["everything".into()],
            |r: &mut EnrollmentRequest| r.protocol_max = 99,
            |r: &mut EnrollmentRequest| r.device_id = uuid::Uuid::new_v4().to_string(),
        ];
        for m in mutations {
            let mut bad = req.clone();
            m(&mut bad);
            assert_eq!(
                bad.verify_self_signature().unwrap_err(),
                ERR_REQUEST_INVALID,
                "every signed field must be covered by the signature"
            );
        }
        // A request signed by a DIFFERENT key, claiming this device's public key.
        let d2 = tmp_dir();
        let other = create_identity(&d2).unwrap();
        let mut forged = req.clone();
        use base64::Engine;
        forged.signature =
            base64::engine::general_purpose::STANDARD.encode(other.sign(&forged.canonical()));
        assert_eq!(forged.verify_self_signature().unwrap_err(), ERR_REQUEST_INVALID);

        // Two requests from the same device differ — the nonce is fresh.
        let r2 = create_enrollment_request(
            &key, INSTALL_B, "tenant-1", "branch-main", "client", &["sync".to_string()], 1, 3,
        )
        .unwrap();
        assert_ne!(r2.request_nonce, req.request_nonce);
        assert_ne!(r2.request_hash(), req.request_hash());
    }

    // ── D8/D9/D10/D11: the owner gate ────────────────────────────────────────
    #[test]
    fn d8_d9_d10_d11_owner_gate() {
        let s = server();

        // D9 — the legacy default is dead (M6-B2A4), so it cannot approve anything.
        assert!(
            primary::authorize_owner(&s.conn, "tenant-1", "branch-main", "admin@lataif.com", "admin")
                .is_err(),
            "D9: admin/admin must never authorize"
        );
        // D10 — staff with correct credentials, wrong role.
        let sh = bcrypt::hash("staff-pw", 4).unwrap();
        s.conn
            .execute(
                "INSERT INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at)
                 VALUES ('user-staff','tenant-1','staff@x.com',?1,'S',1,'n','n')",
                params![sh],
            )
            .unwrap();
        s.conn
            .execute_batch("INSERT INTO user_branches VALUES ('user-staff','branch-main','staff',1,'n');")
            .unwrap();
        assert!(
            primary::authorize_owner(&s.conn, "tenant-1", "branch-main", "staff@x.com", "staff-pw")
                .is_err(),
            "D10: staff must not authorize enrollment"
        );
        // Wrong password.
        assert!(
            primary::authorize_owner(&s.conn, "tenant-1", "branch-main", "owner@x.com", "nope")
                .is_err()
        );
        // D8 — the real owner can.
        assert!(
            primary::authorize_owner(&s.conn, "tenant-1", "branch-main", "owner@x.com", OWNER_PW)
                .is_ok()
        );

        // D11 — a request for a tenant/branch the owner is not granting is refused rather
        // than silently overridden.
        let d = tmp_dir();
        let key = create_identity(&d).unwrap();
        let wrong_tenant = create_enrollment_request(
            &key, INSTALL_B, "tenant-2", "branch-main", "client", &["sync".to_string()], 1, 3,
        )
        .unwrap();
        assert_eq!(s.approve(&wrong_tenant).unwrap_err(), ERR_TENANT_MISMATCH);
        let wrong_branch = create_enrollment_request(
            &key, INSTALL_B, "tenant-1", "branch-two", "client", &["sync".to_string()], 1, 3,
        )
        .unwrap();
        assert_eq!(s.approve(&wrong_branch).unwrap_err(), ERR_BRANCH_MISMATCH);
    }

    // ── the request cannot grant itself anything ─────────────────────────────
    #[test]
    fn a_request_never_grants_its_own_role() {
        let s = server();
        let d = tmp_dir();
        let key = create_identity(&d).unwrap();
        // The device asks to be an owner with every capability under the sun.
        let greedy = create_enrollment_request(
            &key,
            INSTALL_B,
            "tenant-1",
            "branch-main",
            "owner",
            &["admin".to_string(), "everything".to_string()],
            1,
            99,
        )
        .unwrap();
        assert!(greedy.verify_self_signature().is_ok(), "the request is validly signed…");

        let (cert, _r) = s.approve(&greedy).unwrap();
        // …and it gets exactly what the OWNER granted, not what it asked for.
        assert_eq!(cert.payload.device_role, "client", "the grant decides the role");
        assert_eq!(cert.payload.capabilities, vec!["sync".to_string()]);
        assert_eq!(cert.payload.protocol_max, 3, "not the requested 99");
    }

    // ── D12/D13: the certificate binds install_id AND the public key ─────────
    #[test]
    fn d12_d13_certificate_binds_install_and_key() {
        let s = server();
        let d = tmp_dir();
        let (key, req) = device_request(&d, INSTALL_B);
        let (cert, _resp) = s.approve(&req).unwrap();

        assert_eq!(cert.payload.install_id, INSTALL_B, "D12");
        assert_eq!(cert.payload.device_public_key, key.public_key_b64(), "D13");

        let ok = DeviceVerifyContext {
            tenant_id: "tenant-1",
            branch_id: "branch-main",
            root: &s.root,
            expect_install_id: Some(INSTALL_B),
            expect_public_key: Some(&key.public_key_b64()),
        };
        assert!(verify_certificate(&cert, &ok).is_ok());

        // D12 — the same certificate on another installation.
        let wrong_install = DeviceVerifyContext { expect_install_id: Some(INSTALL_A), ..ok };
        assert_eq!(verify_certificate(&cert, &wrong_install).unwrap_err(), ERR_INSTALL_MISMATCH);

        // D13 — the same certificate with another device's key.
        let d2 = tmp_dir();
        let other = create_identity(&d2).unwrap();
        let other_pk = other.public_key_b64();
        let wrong_key = DeviceVerifyContext {
            tenant_id: "tenant-1",
            branch_id: "branch-main",
            root: &s.root,
            expect_install_id: Some(INSTALL_B),
            expect_public_key: Some(&other_pk),
        };
        assert_eq!(verify_certificate(&cert, &wrong_key).unwrap_err(), ERR_KEY_MISMATCH);

        // Any edit to the payload breaks the root signature.
        let mut tampered = cert.clone();
        tampered.payload.device_role = "owner".into();
        assert_eq!(
            verify_certificate(&tampered, &ok).unwrap_err(),
            ERR_CERT_SIGNATURE,
            "the authority signature covers the role"
        );
        let mut caps = cert.clone();
        caps.payload.capabilities.push("admin".into());
        assert_eq!(verify_certificate(&caps, &ok).unwrap_err(), ERR_CERT_SIGNATURE);
    }

    // ── D14: strict parsers ──────────────────────────────────────────────────
    #[test]
    fn d14_strict_parsers_refuse_what_is_not_ours() {
        let s = server();
        let d = tmp_dir();
        let (_key, req) = device_request(&d, INSTALL_B);
        let (cert, resp) = s.approve(&req).unwrap();

        for (raw, kind) in [
            (cert.to_json().unwrap(), "cert"),
            (req.to_json().unwrap(), "request"),
            (resp.to_json().unwrap(), "response"),
        ] {
            // unknown field
            let mut v: serde_json::Value = serde_json::from_str(&raw).unwrap();
            v.as_object_mut().unwrap().insert("extra".into(), serde_json::json!(1));
            let s2 = v.to_string();
            assert!(
                match kind {
                    "cert" => DeviceCertificate::from_json(&s2).is_err(),
                    "request" => EnrollmentRequest::from_json(&s2).is_err(),
                    _ => EnrollmentResponse::from_json(&s2).is_err(),
                },
                "{kind}: an unknown field means a format we have not reasoned about"
            );
            // oversize
            assert!(match kind {
                "cert" => DeviceCertificate::from_json(&"x".repeat(MAX_CERTIFICATE_BYTES + 1)).is_err(),
                "request" => EnrollmentRequest::from_json(&"x".repeat(MAX_REQUEST_BYTES + 1)).is_err(),
                _ => EnrollmentResponse::from_json(&"x".repeat(MAX_RESPONSE_BYTES + 1)).is_err(),
            });
        }

        // missing required field
        let mut v: serde_json::Value = serde_json::from_str(&req.to_json().unwrap()).unwrap();
        v.as_object_mut().unwrap().remove("request_nonce");
        assert!(EnrollmentRequest::from_json(&v.to_string()).is_err());

        // wrong purpose, both directions — the sibling format is refused BY NAME.
        let mut v: serde_json::Value = serde_json::from_str(&req.to_json().unwrap()).unwrap();
        v["purpose"] = serde_json::json!(PURPOSE_RESPONSE);
        assert_eq!(EnrollmentRequest::from_json(&v.to_string()).unwrap_err(), ERR_WRONG_PURPOSE);
        let mut v: serde_json::Value = serde_json::from_str(&resp.to_json().unwrap()).unwrap();
        v["purpose"] = serde_json::json!(PURPOSE_REQUEST);
        assert_eq!(EnrollmentResponse::from_json(&v.to_string()).unwrap_err(), ERR_WRONG_PURPOSE);

        // exact encodings
        for (field, val) in [
            ("device_public_key", b64x(31)),
            ("request_nonce", b64x(31)),
            ("signature", b64x(63)),
        ] {
            let mut v: serde_json::Value = serde_json::from_str(&req.to_json().unwrap()).unwrap();
            v[field] = serde_json::json!(val);
            assert!(
                EnrollmentRequest::from_json(&v.to_string()).is_err(),
                "{field} has a fixed length fixed by the algorithm"
            );
        }
        // version
        let mut v: serde_json::Value = serde_json::from_str(&cert.to_json().unwrap()).unwrap();
        v["payload"]["format_version"] = serde_json::json!(9);
        assert!(DeviceCertificate::from_json(&v.to_string()).is_err());
        // an inverted protocol range is not a range
        let mut v: serde_json::Value = serde_json::from_str(&cert.to_json().unwrap()).unwrap();
        v["payload"]["protocol_min"] = serde_json::json!(9);
        v["payload"]["protocol_max"] = serde_json::json!(2);
        assert!(DeviceCertificate::from_json(&v.to_string()).is_err());
        // no silent Option default: previous_certificate_serial must be PRESENT (may be null)
        let mut v: serde_json::Value = serde_json::from_str(&cert.to_json().unwrap()).unwrap();
        v["payload"].as_object_mut().unwrap().remove("previous_certificate_serial");
        assert!(
            DeviceCertificate::from_json(&v.to_string()).is_err(),
            "serde fills a missing Option with None unless deserialize_with says otherwise"
        );

        // The good ones still parse — otherwise the assertions above prove nothing.
        assert!(DeviceCertificate::from_json(&cert.to_json().unwrap()).is_ok());
        assert!(EnrollmentRequest::from_json(&req.to_json().unwrap()).is_ok());
        assert!(EnrollmentResponse::from_json(&resp.to_json().unwrap()).is_ok());
    }

    fn b64x(n: usize) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(vec![0u8; n])
    }

    // ── D15/D16: import idempotent / contradicting import refused ────────────
    #[test]
    fn d15_d16_import_is_idempotent_and_conflicts_fail_closed() {
        let s = server();
        let d = tmp_dir();
        let (_key, req) = device_request(&d, INSTALL_B);
        let (_cert, resp) = s.approve(&req).unwrap();
        let raw = resp.to_json().unwrap();

        assert_eq!(
            import_enrollment_response(&d, &raw, INSTALL_B, Some(&s.root_fp()), Some(&req.request_id))
                .unwrap(),
            EnrollOutcome::Enrolled
        );
        assert_eq!(resolve_state(&d), DeviceState::Enrolled);
        // D15 — the same bytes again.
        assert_eq!(
            import_enrollment_response(&d, &raw, INSTALL_B, Some(&s.root_fp()), Some(&req.request_id))
                .unwrap(),
            EnrollOutcome::AlreadyEnrolled
        );

        // D16 — a response for a DIFFERENT device.
        let d2 = tmp_dir();
        let (_k2, req2) = device_request(&d2, INSTALL_A);
        let s2 = server();
        let (_c2, resp2) = s2.approve(&req2).unwrap();
        assert_eq!(
            import_enrollment_response(&d, &resp2.to_json().unwrap(), INSTALL_B, Some(&s2.root_fp()), None)
                .unwrap_err(),
            ERR_DEVICE_MISMATCH
        );
        // …the wrong install id.
        assert_eq!(
            import_enrollment_response(&d, &raw, INSTALL_A, Some(&s.root_fp()), None).unwrap_err(),
            ERR_INSTALL_MISMATCH
        );
        // …and a response answering a request we never made.
        assert_eq!(
            import_enrollment_response(&d, &raw, INSTALL_B, Some(&s.root_fp()), Some("other-request"))
                .unwrap_err(),
            ERR_RESPONSE_INVALID
        );
    }

    // ── D17/D18/D19: revocation, retirement, re-enrollment ───────────────────
    #[test]
    fn d17_d18_d19_revocation_retirement_reenrollment() {
        // D17 — revocation blocks the registry status.
        {
            let s = server();
            let d = tmp_dir();
            let (_key, req) = device_request(&d, INSTALL_B);
            let (cert, _r) = s.approve(&req).unwrap();
            assert!(load_device(&s.conn, &req.device_id).unwrap().unwrap().state.is_usable());

            revoke_device(&s.conn, &req.device_id, RevokeReason::Revoked, Some("stolen"), &s.owner)
                .unwrap();
            let dev = load_device(&s.conn, &req.device_id).unwrap().unwrap();
            assert_eq!(dev.state, RegistryState::Revoked);
            assert!(!dev.state.is_usable(), "D17");
            assert_eq!(dev.active_certificate_serial, None);
            assert_eq!(
                certificate_status(&s.conn, &cert.payload.certificate_serial).unwrap().as_deref(),
                Some("revoked")
            );
            // The signature still verifies — revocation is a DB fact, not a crypto one. That
            // is precisely why the registry has to be consulted and not just the maths.
            assert!(verify_certificate(
                &cert,
                &DeviceVerifyContext {
                    tenant_id: "tenant-1",
                    branch_id: "branch-main",
                    root: &s.root,
                    expect_install_id: Some(INSTALL_B),
                    expect_public_key: None,
                }
            )
            .is_ok());
            // Idempotent for the same reason; contradictory for another.
            assert!(revoke_device(&s.conn, &req.device_id, RevokeReason::Revoked, None, &s.owner)
                .is_ok());
            assert_eq!(
                revoke_device(&s.conn, &req.device_id, RevokeReason::Retired, None, &s.owner)
                    .unwrap_err(),
                ERR_CONFLICT
            );
        }
        // D18 — retirement is irreversible. There is no un-retire, by construction.
        {
            let s = server();
            let d = tmp_dir();
            let (_key, req) = device_request(&d, INSTALL_B);
            s.approve(&req).unwrap();
            revoke_device(&s.conn, &req.device_id, RevokeReason::Retired, None, &s.owner).unwrap();
            assert_eq!(
                load_device(&s.conn, &req.device_id).unwrap().unwrap().state,
                RegistryState::Retired
            );
            // A re-approval of the SAME device is refused: the way back is a new keypair,
            // which is a different device.
            assert_eq!(s.approve(&req).unwrap_err(), ERR_CONFLICT, "D18: terminal is terminal");
            assert_eq!(
                begin_reenrollment(&s.conn, &req.device_id, &s.owner).unwrap_err(),
                ERR_CONFLICT
            );
        }
        // D19 — re-enrollment replaces the old certificate.
        {
            let s = server();
            let d = tmp_dir();
            let (_key, req) = device_request(&d, INSTALL_B);
            let (first, _r) = s.approve(&req).unwrap();

            begin_reenrollment(&s.conn, &req.device_id, &s.owner).unwrap();
            let dev = load_device(&s.conn, &req.device_id).unwrap().unwrap();
            assert_eq!(dev.state, RegistryState::ReenrollmentRequired);
            assert_eq!(dev.active_certificate_serial, None);
            assert_eq!(
                certificate_status(&s.conn, &first.payload.certificate_serial).unwrap().as_deref(),
                Some("superseded")
            );

            // The device comes back with a request; the same device_id and key re-enroll.
            let (second, _r2) = s.approve(&req).unwrap();
            assert_ne!(second.payload.certificate_serial, first.payload.certificate_serial);
            assert_eq!(
                second.payload.previous_certificate_serial, None,
                "the chain link is only set when a certificate was ACTIVE at issue time"
            );
            let dev = load_device(&s.conn, &req.device_id).unwrap().unwrap();
            assert_eq!(dev.state, RegistryState::Active);
            assert_eq!(dev.active_certificate_serial.as_deref(), Some(second.payload.certificate_serial.as_str()));
            // The DB enforces "one active certificate per device", not just the code.
            let n: i64 = s
                .conn
                .query_row(
                    "SELECT COUNT(*) FROM device_certificates WHERE device_id = ?1 AND status = 'active'",
                    params![req.device_id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1);
        }
    }

    // ── D20/D21: private keys never reach SQLite, logs or text ───────────────
    #[test]
    fn d20_d21_private_keys_never_reach_storage_or_text() {
        use base64::Engine;
        let s = server();
        let d = tmp_dir();
        let (key, req) = device_request(&d, INSTALL_B);
        let (cert, resp) = s.approve(&req).unwrap();

        // The seed, in every encoding someone might grep for.
        let raw_id = std::fs::read_to_string(d.join(IDENTITY_FILENAME)).unwrap();
        let seed_line = raw_id
            .lines()
            .find(|l| l.starts_with("seed="))
            .unwrap()
            .trim_start_matches("seed=")
            .to_string();
        let seed = base64::engine::general_purpose::STANDARD.decode(&seed_line).unwrap();
        let seed_hex: String = seed.iter().map(|b| format!("{b:02x}")).collect();

        // D20 — dump the ENTIRE database as text and look for it.
        let mut dump = String::new();
        for table in ["enrolled_devices", "device_certificates", "device_enrollment_requests"] {
            let mut st = s.conn.prepare(&format!("SELECT * FROM {table}")).unwrap();
            let cols = st.column_count();
            let mut rows = st.query([]).unwrap();
            while let Some(r) = rows.next().unwrap() {
                for i in 0..cols {
                    if let Ok(v) = r.get::<_, String>(i) {
                        dump.push_str(&v);
                        dump.push('\n');
                    }
                }
            }
        }
        assert!(!dump.is_empty(), "the dump must actually contain the registry");
        assert!(!dump.contains(&seed_line), "D20: the private seed must never reach SQLite");
        assert!(!dump.contains(&seed_hex));
        // The PUBLIC key is expected to be there — assert we did not confuse the two.
        assert!(dump.contains(&key.public_key_b64()), "the public key belongs in the registry");
        assert_ne!(key.public_key_b64(), seed_line, "public key is not the seed");

        // D21 — nothing that gets written, displayed or logged carries it.
        let surfaces = vec![
            cert.to_json().unwrap(),
            req.to_json().unwrap(),
            resp.to_json().unwrap(),
            format!("{key:?}"),
            format!("{cert:?}"),
            format!("{req:?}"),
        ];
        for s in &surfaces {
            assert!(!s.contains(&seed_line), "the seed must never appear");
            assert!(!s.contains(&seed_hex));
        }
        // Debug is hand-written and redacted, not derived.
        let dbg = format!("{key:?}");
        assert!(dbg.contains("redacted"));
        assert!(!dbg.contains(&seed_line));

        // Error codes are constants, not formatted values that could carry data.
        for e in [ERR_IDENTITY_INVALID, ERR_CERT_SIGNATURE, ERR_REQUEST_INVALID, ERR_CONFLICT] {
            assert!(!e.contains(&seed_hex));
            assert!(e.chars().all(|c| c.is_ascii_uppercase() || c == '_'));
        }
    }

    // ── D22/D23: a copied DB / a copied certificate is not enough ────────────
    #[test]
    fn d22_d23_copies_without_the_private_key_prove_nothing() {
        let s = server();
        let d = tmp_dir();
        let (key, req) = device_request(&d, INSTALL_B);
        let (cert, resp) = s.approve(&req).unwrap();
        store_certificate(&d, &cert).unwrap();

        // D22 — an attacker has the whole server database. It holds the public key, the
        // certificate, the state… and nothing that can sign.
        let stolen_pk = load_device(&s.conn, &req.device_id).unwrap().unwrap().device_public_key;
        assert_eq!(stolen_pk, key.public_key_b64());
        let thief = tmp_dir();
        assert_eq!(resolve_state(&thief), DeviceState::IdentityMissing);
        // The thief cannot produce a request that verifies as this device: signing needs the
        // private half, which was never in the database.
        let thief_key = create_identity(&thief).unwrap();
        let mut impersonation = create_enrollment_request(
            &thief_key, INSTALL_B, "tenant-1", "branch-main", "client", &["sync".to_string()], 1, 3,
        )
        .unwrap();
        impersonation.device_public_key = stolen_pk.clone();
        assert_eq!(
            impersonation.verify_self_signature().unwrap_err(),
            ERR_REQUEST_INVALID,
            "D22: knowing a public key is not holding the private one"
        );

        // D23 — the attacker also copies the certificate FILE onto their machine.
        std::fs::copy(d.join(CERTIFICATE_FILENAME), thief.join(CERTIFICATE_FILENAME)).unwrap();
        // Their own key does not match the certificate: the local state machine notices.
        assert_eq!(
            resolve_state(&thief),
            DeviceState::IdentityCorrupt,
            "D23: a certificate for someone else's key next to my key is not an identity"
        );
        // And verification against their key fails on the binding.
        assert_eq!(
            verify_certificate(
                &cert,
                &DeviceVerifyContext {
                    tenant_id: "tenant-1",
                    branch_id: "branch-main",
                    root: &s.root,
                    expect_install_id: Some(INSTALL_B),
                    expect_public_key: Some(&thief_key.public_key_b64()),
                }
            )
            .unwrap_err(),
            ERR_KEY_MISMATCH
        );
        // Importing the response on a machine with the wrong install id also fails.
        assert_eq!(
            import_enrollment_response(&thief, &resp.to_json().unwrap(), INSTALL_A, Some(&s.root_fp()), None)
                .unwrap_err(),
            ERR_DEVICE_MISMATCH
        );
    }

    // ── D24: the limit this slice does NOT close ─────────────────────────────
    #[test]
    fn d24_a_full_appdata_clone_remains_indistinguishable() {
        let s = server();
        let original = tmp_dir();
        let (key, req) = device_request(&original, INSTALL_B);
        let (cert, _r) = s.approve(&req).unwrap();
        store_certificate(&original, &cert).unwrap();
        assert_eq!(resolve_state(&original), DeviceState::Enrolled);

        // A full AppData clone: the key file AND the certificate, byte for byte.
        let clone = tmp_dir();
        std::fs::copy(original.join(IDENTITY_FILENAME), clone.join(IDENTITY_FILENAME)).unwrap();
        std::fs::copy(original.join(CERTIFICATE_FILENAME), clone.join(CERTIFICATE_FILENAME))
            .unwrap();

        // This is the honest part. The clone is Enrolled, holds the same device_id, the same
        // key, and produces signatures that verify identically. Software cannot tell them
        // apart, and this test exists to say so out loud rather than let a future reader
        // assume otherwise.
        assert_eq!(resolve_state(&clone), DeviceState::Enrolled);
        let clone_key = load_identity(&clone).unwrap();
        assert_eq!(clone_key.device_id(), key.device_id());
        assert_eq!(clone_key.public_key_b64(), key.public_key_b64());

        let msg = b"anything";
        let a = key.sign(msg);
        let b = clone_key.sign(msg);
        // Ed25519 is deterministic: the two machines produce byte-identical signatures.
        assert_eq!(a, b, "a clone is not distinguishable by its output");
        assert!(trust_root::verify_signature(&key.public_key_b64(), msg, &b));

        // What DID improve: a database copy alone is no longer enough (D22), and both
        // clones share ONE registry row — so parallel use is at least detectable, which is
        // the most this slice claims. Detection is not prevention.
        let dev = load_device(&s.conn, &req.device_id).unwrap().unwrap();
        assert_eq!(dev.device_id, clone_key.device_id());
        assert_eq!(
            dev.install_id, INSTALL_B,
            "the registry knows ONE install id for this device — a clone elsewhere contradicts it"
        );
    }

    // ── §5: the DB carries the invariants, not just the code ─────────────────
    #[test]
    fn the_database_enforces_the_registry_invariants() {
        let s = server();
        let d = tmp_dir();
        let (_key, req) = device_request(&d, INSTALL_B);
        s.approve(&req).unwrap();

        // One public key belongs to one device.
        let dev = load_device(&s.conn, &req.device_id).unwrap().unwrap();
        assert!(
            s.conn
                .execute(
                    "INSERT INTO enrolled_devices
                       (device_id, tenant_id, branch_id, install_id, device_public_key,
                        device_role, capabilities, protocol_min, protocol_max, state, created_at)
                     VALUES ('other-device','tenant-1','branch-main',?1,?2,'client','',1,1,'pending','n')",
                    params![INSTALL_A, dev.device_public_key],
                )
                .is_err(),
            "two devices sharing a public key could each satisfy the other's proof"
        );
        // Unknown states are refused outright.
        assert!(s
            .conn
            .execute(
                "INSERT INTO enrolled_devices
                   (device_id, tenant_id, branch_id, install_id, device_public_key,
                    device_role, capabilities, protocol_min, protocol_max, state, created_at)
                 VALUES ('x','tenant-1','branch-main','i','k','client','',1,1,'nonsense','n')",
                [],
            )
            .is_err());
        // An inverted protocol range.
        assert!(s
            .conn
            .execute(
                "INSERT INTO enrolled_devices
                   (device_id, tenant_id, branch_id, install_id, device_public_key,
                    device_role, capabilities, protocol_min, protocol_max, state, created_at)
                 VALUES ('y','tenant-1','branch-main','i','k2','client','',5,2,'pending','n')",
                [],
            )
            .is_err());
        // An active row with no certificate.
        assert!(s
            .conn
            .execute(
                "INSERT INTO enrolled_devices
                   (device_id, tenant_id, branch_id, install_id, device_public_key,
                    device_role, capabilities, protocol_min, protocol_max, state, created_at,
                    enrolled_at)
                 VALUES ('z','tenant-1','branch-main','i','k3','client','',1,1,'active','n','n')",
                [],
            )
            .is_err());
    }

    // ── §6: a replayed request cannot mint a second certificate ──────────────
    #[test]
    fn a_replayed_request_cannot_mint_a_second_certificate() {
        let s = server();
        let d = tmp_dir();
        let (_key, req) = device_request(&d, INSTALL_B);
        let (first, _r) = s.approve(&req).unwrap();

        // The same request approved twice: the device is already active, so this is a
        // re-issue for the same device, not a new one — and the request_hash index means the
        // request row is updated, never duplicated.
        let (second, _r2) = s.approve(&req).unwrap();
        assert_eq!(
            second.payload.previous_certificate_serial.as_deref(),
            Some(first.payload.certificate_serial.as_str()),
            "the chain records what it replaced"
        );
        let n: i64 = s
            .conn
            .query_row("SELECT COUNT(*) FROM device_enrollment_requests", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "one request, one row");
        let active: i64 = s
            .conn
            .query_row(
                "SELECT COUNT(*) FROM device_certificates WHERE device_id = ?1 AND status='active'",
                params![req.device_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(active, 1, "still exactly one active certificate");
    }

    // ── the states themselves ────────────────────────────────────────────────
    #[test]
    fn states_round_trip_and_only_active_is_usable() {
        for s in [
            RegistryState::Pending,
            RegistryState::Active,
            RegistryState::Revoked,
            RegistryState::Retired,
            RegistryState::Compromised,
            RegistryState::ReenrollmentRequired,
        ] {
            assert_eq!(RegistryState::parse(s.as_str()), Some(s));
            assert_eq!(s.is_usable(), s == RegistryState::Active);
            assert_eq!(
                s.is_terminal(),
                matches!(
                    s,
                    RegistryState::Revoked | RegistryState::Retired | RegistryState::Compromised
                )
            );
        }
        assert_eq!(RegistryState::parse("almost_active"), None);

        for s in [
            DeviceState::IdentityMissing,
            DeviceState::Unenrolled,
            DeviceState::Enrolled,
            DeviceState::ReenrollmentRequired,
            DeviceState::CertificateMissing,
            DeviceState::IdentityCorrupt,
            DeviceState::Revoked,
        ] {
            assert_eq!(s.can_prove_possession(), s == DeviceState::Enrolled);
            assert!(!s.as_str().is_empty());
        }
    }


    // ── D19 (device side): losing a key and coming back with a new one ───────
    #[test]
    fn d19_device_side_reenrollment_replaces_key_and_certificate() {
        let s = server();
        let d = tmp_dir();
        let (old_key, req) = device_request(&d, INSTALL_B);
        let (old_cert, _r) = s.approve(&req).unwrap();
        store_certificate(&d, &old_cert).unwrap();
        let old_pub = old_key.public_key_b64();
        let old_device_id = old_key.device_id().to_string();
        assert_eq!(resolve_state(&d), DeviceState::Enrolled);
        drop(old_key);

        // The key is lost. The device is stuck: it cannot prove possession, and it must not
        // quietly mint a replacement (D4).
        std::fs::remove_file(d.join(IDENTITY_FILENAME)).unwrap();
        assert_eq!(resolve_state(&d), DeviceState::ReenrollmentRequired);
        assert_eq!(create_identity(&d).unwrap_err(), ERR_REENROLLMENT_REQUIRED);

        // The OWNER starts a re-enrollment on the server…
        begin_reenrollment(&s.conn, &old_device_id, &s.owner).unwrap();
        assert_eq!(
            certificate_status(&s.conn, &old_cert.payload.certificate_serial).unwrap().as_deref(),
            Some("superseded")
        );

        // …and only then may the device discard its dead identity. The name says what it is:
        // no automatic path calls this, because deleting a key that merely looks unusable is
        // how a working device silently becomes a new one.
        discard_identity_for_reenrollment(&d).unwrap();
        assert_eq!(resolve_state(&d), DeviceState::IdentityMissing);

        // A NEW keypair — genuinely new, not the old one recovered.
        let new_key = create_identity(&d).unwrap();
        assert_ne!(new_key.public_key_b64(), old_pub, "no silent key rotation: this is a new key");
        assert_ne!(new_key.device_id(), old_device_id, "and a new device id");

        let new_req = create_enrollment_request(
            &new_key, INSTALL_B, "tenant-1", "branch-main", "client", &["sync".to_string()], 1, 3,
        )
        .unwrap();
        let (new_cert, _r2) = s.approve(&new_req).unwrap();
        replace_certificate(&d, &new_cert).unwrap();
        assert_eq!(resolve_state(&d), DeviceState::Enrolled);
        assert_eq!(load_certificate(&d).unwrap().payload.device_public_key, new_key.public_key_b64());

        // The old certificate cannot be re-adopted: it names a key nobody holds.
        assert_eq!(store_certificate(&d, &old_cert).unwrap_err(), ERR_DEVICE_MISMATCH);
        // Two rows now — the old device and the new one. The old one is history, not reused.
        let old_row = load_device(&s.conn, &old_device_id).unwrap().unwrap();
        assert_eq!(old_row.state, RegistryState::ReenrollmentRequired);
        assert_eq!(old_row.active_certificate_serial, None);
        let new_row = load_device(&s.conn, new_key.device_id()).unwrap().unwrap();
        assert_eq!(new_row.state, RegistryState::Active);
    }

    // ── the registry overrides a locally healthy-looking device ──────────────
    #[test]
    fn the_registry_overrides_the_local_file_view() {
        let s = server();
        let d = tmp_dir();
        let (_key, req) = device_request(&d, INSTALL_B);
        let (cert, _r) = s.approve(&req).unwrap();
        store_certificate(&d, &cert).unwrap();

        // Local files say Enrolled, and they are not lying — they are just not the whole
        // truth.
        assert_eq!(resolve_state(&d), DeviceState::Enrolled);
        assert_eq!(resolve_state_with_registry(&s.conn, &d), DeviceState::Enrolled);

        revoke_device(&s.conn, &req.device_id, RevokeReason::Revoked, Some("stolen"), &s.owner)
            .unwrap();

        // The files have not changed one byte…
        assert_eq!(resolve_state(&d), DeviceState::Enrolled, "the disk cannot know");
        // …and the answer that counts has.
        assert_eq!(
            resolve_state_with_registry(&s.conn, &d),
            DeviceState::Revoked,
            "a device cannot revoke itself, and it cannot know it was revoked without asking"
        );
        assert!(!resolve_state_with_registry(&s.conn, &d).can_prove_possession());
    }

// ═══════════════════════════════════════════════════════════════════════
    // M6-B2DE1 §9 — enrollment attack tests. The chain must be anchored to a root
    // the owner confirmed out-of-band, not merely internally consistent.
    // ═══════════════════════════════════════════════════════════════════════

    /// A device that has created its key and requested enrollment, plus the server's response.
    fn enrolled_pair() -> (Server, TempDir, EnrollmentRequest, EnrollmentResponse) {
        let s = server();
        let d = tmp_dir();
        let (_key, req) = device_request(&d, INSTALL_B);
        let (_cert, resp) = s.approve(&req).unwrap();
        (s, d, req, resp)
    }

    // ── E1: a valid chain + the correct out-of-band fingerprint → enrolled ────
    #[test]
    fn e1_valid_chain_with_confirmed_fingerprint_enrolls() {
        let (s, d, req, resp) = enrolled_pair();
        let raw = resp.to_json().unwrap();
        assert_eq!(
            import_enrollment_response(&d, &raw, INSTALL_B, Some(&s.root_fp()), Some(&req.request_id))
                .unwrap(),
            EnrollOutcome::Enrolled
        );
        assert_eq!(resolve_state(&d), DeviceState::Enrolled);
        // The anchor is now pinned, and it names the confirmed root.
        let anchor = load_trust_anchor(&d).unwrap().unwrap();
        assert_eq!(anchor.root_fingerprint, s.root_fp());
        assert_eq!(anchor.root_public_key, s.root.public_key);
        assert_eq!(anchor.root_key_id, s.root.root_key_id);
    }

    // ── E12: the fingerprint is NEVER trusted from the response alone ─────────
    #[test]
    fn e12_first_import_requires_the_out_of_band_fingerprint() {
        let (_s, d, req, resp) = enrolled_pair();
        let raw = resp.to_json().unwrap();
        // No fingerprint supplied — the response carries one, but taking it from the same
        // file that carries the chain would let the file vouch for itself. Refused.
        assert_eq!(
            import_enrollment_response(&d, &raw, INSTALL_B, None, Some(&req.request_id)).unwrap_err(),
            ERR_ROOT_FINGERPRINT_REQUIRED
        );
        assert_eq!(resolve_state(&d), DeviceState::Unenrolled, "nothing was pinned or stored");
        assert!(!trust_anchor_exists(&d));
    }

    // ── E2/E3: a whole forged chain from an attacker's own root → refused ─────
    #[test]
    fn e2_e3_a_foreign_or_forged_root_chain_is_refused() {
        // The honest server the owner actually confirmed.
        let honest = server();
        let d = tmp_dir();
        let (_key, req) = device_request(&d, INSTALL_B);

        // E3 — the attacker stands up their OWN primary with the SAME tenant/branch strings
        // and signs a complete, internally perfect chain: their root, their authority, a
        // device cert for this very device. Every signature inside it verifies.
        let attacker = server();
        let (_c, forged) = attacker.approve(&req).unwrap();
        // The forged chain is internally valid — prove the device cert really verifies against
        // the attacker's own root, so the test is about the anchor and not a broken forgery.
        let forged_dcert = DeviceCertificate::from_json(&forged.device_certificate).unwrap();
        assert!(verify_certificate(
            &forged_dcert,
            &DeviceVerifyContext {
                tenant_id: "tenant-1",
                branch_id: "branch-main",
                root: &attacker.root,
                expect_install_id: Some(INSTALL_B),
                expect_public_key: None,
            }
        )
        .is_ok());

        // But the owner confirms the HONEST root's fingerprint out-of-band. The forged chain
        // hangs from a different root, so its fingerprint does not match — refused before a
        // single signature is checked.
        assert_eq!(
            import_enrollment_response(
                &d,
                &forged.to_json().unwrap(),
                INSTALL_B,
                Some(&honest.root_fp()),
                Some(&req.request_id),
            )
            .unwrap_err(),
            ERR_ROOT_FINGERPRINT_MISMATCH,
            "E3: a forged chain from the attacker's own root is caught by the out-of-band pin"
        );
        assert!(!trust_anchor_exists(&d), "nothing pinned");

        // E2 — even the attacker's fingerprint, confirmed, only enrolls INTO the attacker's
        // root. It cannot impersonate the honest root, because the honest root's fingerprint
        // is a different 64 characters. (This just confirms the pin is to a specific root.)
        assert_ne!(honest.root_fp(), attacker.root_fp());
    }

    // ── E4: a tampered root public key (fingerprint no longer matches) ────────
    #[test]
    fn e4_tampered_root_public_key_is_refused() {
        let (s, d, req, mut resp) = enrolled_pair();
        // Swap in a different public key but leave the fingerprint — now they disagree.
        let other = server();
        resp.tenant_root_public_key = other.root.public_key.clone();
        assert_eq!(
            import_enrollment_response(
                &d,
                &resp.to_json().unwrap(),
                INSTALL_B,
                Some(&s.root_fp()),
                Some(&req.request_id),
            )
            .unwrap_err(),
            ERR_RESPONSE_INVALID,
            "E4: fingerprint must be the real SHA-256 of the public key"
        );
    }

    // ── E5: authority cert signed by a foreign root → refused ────────────────
    #[test]
    fn e5_authority_cert_from_a_foreign_root_is_refused() {
        let (s, d, req, mut resp) = enrolled_pair();
        // Replace the authority cert with one from a DIFFERENT root, but keep the honest root
        // fields and the honest device cert.
        let other = server();
        resp.authority_certificate = other.authority_cert_json.clone();
        assert_eq!(
            import_enrollment_response(
                &d,
                &resp.to_json().unwrap(),
                INSTALL_B,
                Some(&s.root_fp()),
                Some(&req.request_id),
            )
            .unwrap_err(),
            ERR_AUTHORITY_CERT_INVALID,
            "E5: an authority cert not signed by the pinned root cannot verify"
        );
    }

    // ── E6: device cert descends from an authority the chain does not prove ───
    #[test]
    fn e6_device_cert_from_a_foreign_authority_is_refused() {
        // Honest root, honest authority cert — but a device cert whose authority_id/epoch do
        // not match the authority cert in the response.
        let s = server();
        let d = tmp_dir();
        let (_key, req) = device_request(&d, INSTALL_B);
        let (_c, mut resp) = s.approve(&req).unwrap();

        // Forge a device cert (still root-signed, so verify_certificate passes) but claiming a
        // different authority than the one the response's authority cert attests.
        let dcert = DeviceCertificate::from_json(&resp.device_certificate).unwrap();
        let mut payload = dcert.payload.clone();
        payload.authority_id = "99999999-9999-4999-8999-999999999999".to_string();
        let key = s.key();
        use base64::Engine;
        let forged = DeviceCertificate {
            signature: base64::engine::general_purpose::STANDARD.encode(key.sign(&payload.canonical())),
            payload,
        };
        resp.device_certificate = forged.to_json().unwrap();
        assert_eq!(
            import_enrollment_response(
                &d,
                &resp.to_json().unwrap(),
                INSTALL_B,
                Some(&s.root_fp()),
                Some(&req.request_id),
            )
            .unwrap_err(),
            ERR_AUTHORITY_CERT_INVALID,
            "E6: the device cert must descend from the authority the chain proves"
        );
    }

    // ── E7: the wrong local install id → refused ─────────────────────────────
    #[test]
    fn e7_wrong_local_install_id_is_refused() {
        let (s, d, req, resp) = enrolled_pair();
        // The response is for INSTALL_B; importing on a machine whose install id is INSTALL_A.
        assert_eq!(
            import_enrollment_response(
                &d,
                &resp.to_json().unwrap(),
                INSTALL_A,
                Some(&s.root_fp()),
                Some(&req.request_id),
            )
            .unwrap_err(),
            ERR_INSTALL_MISMATCH
        );
    }

    // ── E8: the wrong local device key → refused ─────────────────────────────
    #[test]
    fn e8_wrong_local_device_key_is_refused() {
        let s = server();
        let d = tmp_dir();
        let (_key, req) = device_request(&d, INSTALL_B);
        let (_c, resp) = s.approve(&req).unwrap();

        // A DIFFERENT machine (different device key) tries to adopt this response.
        let other_dir = tmp_dir();
        let _other_key = create_identity(&other_dir).unwrap();
        assert_eq!(
            import_enrollment_response(
                &other_dir,
                &resp.to_json().unwrap(),
                INSTALL_B,
                Some(&s.root_fp()),
                None,
            )
            .unwrap_err(),
            ERR_DEVICE_MISMATCH,
            "E8: the response names another device; this key is not it"
        );
    }

    // ── E9: a contradicting existing anchor → fail-closed ────────────────────
    #[test]
    fn e9_a_contradicting_anchor_is_fail_closed() {
        let s = server();
        let d = tmp_dir();
        let (_key, req) = device_request(&d, INSTALL_B);
        let (_c, resp) = s.approve(&req).unwrap();
        // First import pins s's root.
        import_enrollment_response(&d, &resp.to_json().unwrap(), INSTALL_B, Some(&s.root_fp()), Some(&req.request_id))
            .unwrap();
        assert!(trust_anchor_exists(&d));

        // The owner re-enrolls the same device on the server, then a re-import arrives — but
        // it names a DIFFERENT root (a second, unrelated server). The pinned anchor refuses it.
        begin_reenrollment(&s.conn, &req.device_id, &s.owner).unwrap();
        let s2 = server();
        // s2 has no knowledge of this device; enroll it there to get a response from a foreign
        // root that nonetheless targets this install/key.
        let (_c2, foreign_resp) = {
            let key = load_identity(&d).unwrap();
            let req2 = create_enrollment_request(
                &key, INSTALL_B, "tenant-1", "branch-main", "client", &["sync".to_string()], 1, 3,
            )
            .unwrap();
            s2.approve(&req2).unwrap()
        };
        assert_eq!(
            import_enrollment_response(
                &d,
                &foreign_resp.to_json().unwrap(),
                INSTALL_B,
                Some(&s2.root_fp()),
                None,
            )
            .unwrap_err(),
            ERR_ANCHOR_CONFLICT,
            "E9: once a root is pinned, a response naming a different root is refused"
        );
        // The original anchor is untouched.
        let anchor = load_trust_anchor(&d).unwrap().unwrap();
        assert_eq!(anchor.root_fingerprint, s.root_fp());
    }

    // ── E10: an identical re-import is idempotent ────────────────────────────
    #[test]
    fn e10_identical_reimport_is_idempotent() {
        let (s, d, req, resp) = enrolled_pair();
        let raw = resp.to_json().unwrap();
        assert_eq!(
            import_enrollment_response(&d, &raw, INSTALL_B, Some(&s.root_fp()), Some(&req.request_id)).unwrap(),
            EnrollOutcome::Enrolled
        );
        // Same bytes, same confirmed fingerprint, again — a no-op, not a second pin.
        assert_eq!(
            import_enrollment_response(&d, &raw, INSTALL_B, Some(&s.root_fp()), Some(&req.request_id)).unwrap(),
            EnrollOutcome::AlreadyEnrolled
        );
        // And once pinned, the fingerprint is no longer even required — the anchor is the
        // authority now.
        assert_eq!(
            import_enrollment_response(&d, &raw, INSTALL_B, None, Some(&req.request_id)).unwrap(),
            EnrollOutcome::AlreadyEnrolled,
            "after pinning, the anchor carries the trust, not the caller's fingerprint"
        );
    }

    // ── E11: a copied response without the matching private device key → refused
    #[test]
    fn e11_copied_response_without_the_private_key_is_refused() {
        let s = server();
        let d = tmp_dir();
        let (_key, req) = device_request(&d, INSTALL_B);
        let (_c, resp) = s.approve(&req).unwrap();

        // An attacker copies the response file to their own machine. They have the SAME
        // install id (a full clone would), but NOT the private device key — they made their
        // own. The device cert names the original key; the attacker's key does not match it.
        let attacker_dir = tmp_dir();
        let attacker_key = create_identity(&attacker_dir).unwrap();
        assert_ne!(attacker_key.public_key_b64(), load_identity(&d).unwrap().public_key_b64());
        assert_eq!(
            import_enrollment_response(
                &attacker_dir,
                &resp.to_json().unwrap(),
                INSTALL_B,
                Some(&s.root_fp()),
                None,
            )
            .unwrap_err(),
            ERR_DEVICE_MISMATCH,
            "E11: the response is bound to a device key the attacker does not hold"
        );
    }

    // ── the anchor survives a restart and pins across enrollments ────────────
    #[test]
    fn the_trust_anchor_survives_a_restart() {
        let (s, d, req, resp) = enrolled_pair();
        import_enrollment_response(&d, &resp.to_json().unwrap(), INSTALL_B, Some(&s.root_fp()), Some(&req.request_id))
            .unwrap();
        // "Restart": read the anchor back from disk. It is a value, not held in memory.
        let anchor = load_trust_anchor(&d).unwrap().unwrap();
        assert_eq!(anchor.format_version, IDENTITY_FORMAT_VERSION);
        assert_eq!(anchor.tenant_id, "tenant-1");
        assert_eq!(anchor.root_generation, s.root.generation);
        // A parse of a corrupt anchor is fail-closed, never treated as "no anchor".
        std::fs::write(d.join(TRUST_ANCHOR_FILENAME), "{not json").unwrap();
        assert_eq!(load_trust_anchor(&d).unwrap_err(), ERR_ANCHOR_INVALID);
    }

    // ── the anchor is a strict parser ────────────────────────────────────────
    #[test]
    fn trust_anchor_rejects_unknown_and_malformed() {
        let (s, d, req, resp) = enrolled_pair();
        import_enrollment_response(&d, &resp.to_json().unwrap(), INSTALL_B, Some(&s.root_fp()), Some(&req.request_id))
            .unwrap();
        let good = std::fs::read_to_string(d.join(TRUST_ANCHOR_FILENAME)).unwrap();

        // unknown field
        let mut v: serde_json::Value = serde_json::from_str(&good).unwrap();
        v.as_object_mut().unwrap().insert("extra".into(), serde_json::json!(1));
        std::fs::write(d.join(TRUST_ANCHOR_FILENAME), v.to_string()).unwrap();
        assert_eq!(load_trust_anchor(&d).unwrap_err(), ERR_ANCHOR_INVALID);

        // wrong fingerprint length
        let mut v: serde_json::Value = serde_json::from_str(&good).unwrap();
        v["root_fingerprint"] = serde_json::json!("aa");
        std::fs::write(d.join(TRUST_ANCHOR_FILENAME), v.to_string()).unwrap();
        assert_eq!(load_trust_anchor(&d).unwrap_err(), ERR_ANCHOR_INVALID);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // M6-B2DE2 §7/§8 — the signed enrollment approval and the context-binding
    // attacks (A1–A12). Every attack fail-closed and pins nothing.
    // ═══════════════════════════════════════════════════════════════════════

    /// Parse the approval out of a response, let `f` mutate it, optionally re-sign with
    /// `resign`, and put it back. `resign = None` models the realistic attacker (no root key):
    /// the signature breaks. `resign = Some(root)` models a validly-signed-but-disagreeing
    /// approval: the field cross-checks against the certificate/request are what catch it.
    fn tamper_approval(
        resp: &EnrollmentResponse,
        resign: Option<&RootKey>,
        f: impl FnOnce(&mut DeviceEnrollmentApprovalPayload),
    ) -> EnrollmentResponse {
        use base64::Engine;
        let mut appr = DeviceEnrollmentApproval::from_json(&resp.approval).unwrap();
        f(&mut appr.payload);
        if let Some(k) = resign {
            appr.signature = base64::engine::general_purpose::STANDARD
                .encode(k.sign(&appr.payload.canonical()));
        }
        let mut out = resp.clone();
        out.approval = serde_json::to_string(&appr).unwrap();
        out
    }

    /// A valid-shaped but different 32-byte nonce, base64.
    fn other_nonce() -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode([0x5au8; NONCE_LEN])
    }

    fn import_forged(
        d: &Path,
        resp: &EnrollmentResponse,
        fp: Option<&str>,
    ) -> Result<EnrollOutcome, &'static str> {
        import_enrollment_response(d, &resp.to_json().unwrap(), INSTALL_B, fp, None)
    }

    // ── E1 restated: a valid response carries a signed approval that verifies ─
    #[test]
    fn the_response_carries_a_verifiable_signed_approval() {
        let (s, d, req, resp) = enrolled_pair();
        // The approval exists, is root-signed, and binds this exact grant + request + cert.
        let appr = DeviceEnrollmentApproval::from_json(&resp.approval).unwrap();
        assert_eq!(appr.payload.request_id, req.request_id);
        assert_eq!(appr.payload.request_nonce, req.request_nonce);
        let dcert = DeviceCertificate::from_json(&resp.device_certificate).unwrap();
        assert_eq!(appr.payload.device_certificate_serial, dcert.payload.certificate_serial);
        assert_eq!(appr.payload.device_certificate_hash, dcert.payload.payload_hash());
        assert_eq!(appr.payload.registry_record_hash, resp.registry_record_hash);
        // And a clean import accepts it.
        assert_eq!(
            import_enrollment_response(&d, &resp.to_json().unwrap(), INSTALL_B, Some(&s.root_fp()), Some(&req.request_id)).unwrap(),
            EnrollOutcome::Enrolled
        );
    }

    // ── A1: the request id the approval answers is rebound ───────────────────
    #[test]
    fn a1_request_id_rebound_is_refused() {
        let (s, d, _req, resp) = enrolled_pair();
        let bad = tamper_approval(&resp, Some(&s.key()), |p| {
            p.request_id = uuid::Uuid::new_v4().to_string();
        });
        assert_eq!(import_forged(&d, &bad, Some(&s.root_fp())).unwrap_err(), ERR_APPROVAL_MISMATCH);
        assert!(!trust_anchor_exists(&d), "a rejected approval pins nothing");
    }

    // ── A2: the request nonce is rebound ─────────────────────────────────────
    #[test]
    fn a2_request_nonce_rebound_is_refused() {
        let (s, d, _req, resp) = enrolled_pair();
        let bad = tamper_approval(&resp, Some(&s.key()), |p| p.request_nonce = other_nonce());
        assert_eq!(import_forged(&d, &bad, Some(&s.root_fp())).unwrap_err(), ERR_APPROVAL_MISMATCH);
    }

    // ── A3: the granted role disagrees with the certificate ──────────────────
    #[test]
    fn a3_granted_role_rebound_is_refused() {
        let (s, d, _req, resp) = enrolled_pair();
        let bad = tamper_approval(&resp, Some(&s.key()), |p| p.granted_role = "owner".into());
        assert_eq!(import_forged(&d, &bad, Some(&s.root_fp())).unwrap_err(), ERR_APPROVAL_MISMATCH);
    }

    // ── A4: the granted capabilities disagree with the certificate ───────────
    #[test]
    fn a4_capabilities_rebound_is_refused() {
        let (s, d, _req, resp) = enrolled_pair();
        let bad = tamper_approval(&resp, Some(&s.key()), |p| {
            p.granted_capabilities = vec!["admin".into(), "sync".into()];
        });
        assert_eq!(import_forged(&d, &bad, Some(&s.root_fp())).unwrap_err(), ERR_APPROVAL_MISMATCH);
    }

    // ── A5: the protocol range disagrees with the certificate ────────────────
    #[test]
    fn a5_protocol_range_rebound_is_refused() {
        let (s, d, _req, resp) = enrolled_pair();
        let bad = tamper_approval(&resp, Some(&s.key()), |p| p.protocol_max = 99);
        assert_eq!(import_forged(&d, &bad, Some(&s.root_fp())).unwrap_err(), ERR_APPROVAL_MISMATCH);
    }

    // ── A6: the response's registry hash is now pinned by the signed approval ─
    #[test]
    fn a6_registry_hash_tamper_is_refused() {
        let (s, d, _req, resp) = enrolled_pair();
        // Tamper ONLY the response's plaintext registry hash; leave the signed approval intact.
        // The approval's signed copy no longer matches → refused. This is the proof that no
        // security-relevant response metadata is trusted unsigned.
        let mut bad = resp.clone();
        bad.registry_record_hash = "ab".repeat(32);
        assert_eq!(import_forged(&d, &bad, Some(&s.root_fp())).unwrap_err(), ERR_APPROVAL_MISMATCH);
    }

    // ── A1–A6 (signature angle): tampering ANY signed field, without the root
    //    key to re-sign, breaks the approval signature ────────────────────────
    #[test]
    fn tampering_any_signed_field_breaks_the_signature() {
        let (s, d, _req, resp) = enrolled_pair();
        let mutations: Vec<Box<dyn Fn(&mut DeviceEnrollmentApprovalPayload)>> = vec![
            Box::new(|p: &mut DeviceEnrollmentApprovalPayload| p.request_id = uuid::Uuid::new_v4().to_string()),
            Box::new(|p: &mut DeviceEnrollmentApprovalPayload| p.request_nonce = other_nonce()),
            Box::new(|p: &mut DeviceEnrollmentApprovalPayload| p.granted_role = "owner".into()),
            Box::new(|p: &mut DeviceEnrollmentApprovalPayload| p.granted_capabilities = vec!["admin".into()]),
            Box::new(|p: &mut DeviceEnrollmentApprovalPayload| p.protocol_max = 99),
            Box::new(|p: &mut DeviceEnrollmentApprovalPayload| p.registry_record_hash = "cd".repeat(32)),
            Box::new(|p: &mut DeviceEnrollmentApprovalPayload| p.device_certificate_hash = "ef".repeat(32)),
        ];
        for m in mutations {
            let bad = tamper_approval(&resp, None, |p| m(p)); // NOT re-signed
            assert_eq!(
                import_forged(&d, &bad, Some(&s.root_fp())).unwrap_err(),
                ERR_APPROVAL_SIGNATURE,
                "every field is under the signature"
            );
            assert!(!trust_anchor_exists(&d));
        }
    }

    // ── A7: a device certificate from ANOTHER enrollment response ────────────
    #[test]
    fn a7_device_cert_from_another_response_is_refused() {
        let (s, d, req, resp1) = enrolled_pair();
        // A second approval for the same device supersedes the first: a new, validly-signed
        // device certificate + approval.
        let (_c2, resp2) = s.approve(&req).unwrap();
        // Splice enrollment-1's approval onto enrollment-2's certificate.
        let mut spliced = resp2.clone();
        spliced.approval = resp1.approval.clone();
        assert_eq!(
            import_forged(&d, &spliced, Some(&s.root_fp())).unwrap_err(),
            ERR_APPROVAL_MISMATCH,
            "A7: the approval names certificate-1; the response carries certificate-2"
        );
        assert!(!trust_anchor_exists(&d));
    }

    // ── A8: an approval signed by a FOREIGN authority (root) ─────────────────
    #[test]
    fn a8_approval_from_a_foreign_authority_is_refused() {
        let (s, d, _req, resp) = enrolled_pair();
        let attacker = server();
        // Re-sign the approval with the attacker's root. Valid signature — but against a root
        // the target does not trust. The whole rest of the chain is still the honest root's.
        let bad = tamper_approval(&resp, Some(&attacker.key()), |_| {});
        assert_eq!(
            import_forged(&d, &bad, Some(&s.root_fp())).unwrap_err(),
            ERR_APPROVAL_SIGNATURE,
            "A8: the approval must be signed by the SAME root the certificates hang from"
        );
    }

    // ── A9: a whole valid chain from a foreign root with the same strings ────
    #[test]
    fn a9_foreign_root_with_same_tenant_strings_is_refused() {
        let honest = server();
        let d = tmp_dir();
        let (_k, req) = device_request(&d, INSTALL_B);
        // The attacker's own primary, same tenant/branch strings, a complete valid chain +
        // approval for this very device.
        let attacker = server();
        let (_c, forged) = attacker.approve(&req).unwrap();
        // The owner confirms the HONEST root's fingerprint out-of-band → the forged chain (a
        // different root) is refused before any signature maths.
        assert_eq!(
            import_enrollment_response(&d, &forged.to_json().unwrap(), INSTALL_B, Some(&honest.root_fp()), Some(&req.request_id)).unwrap_err(),
            ERR_ROOT_FINGERPRINT_MISMATCH,
        );
        assert!(!trust_anchor_exists(&d));
    }

    // ── A10: a pinned anchor with the right fingerprint but the WRONG branch ─
    #[test]
    fn a10_anchor_with_right_fingerprint_wrong_branch_is_refused() {
        let (s, d, req, resp) = enrolled_pair();
        // Pre-pin an anchor that names s's real root (right fingerprint, key, generation) but a
        // DIFFERENT branch. §5's branch field must make same_root reject the branch-main chain.
        let anchor = TrustAnchor {
            format_version: IDENTITY_FORMAT_VERSION,
            tenant_id: "tenant-1".into(),
            branch_id: "branch-other".into(),
            root_key_id: s.root.root_key_id.clone(),
            root_public_key: s.root.public_key.clone(),
            root_fingerprint: s.root.fingerprint.clone(),
            root_generation: s.root.generation,
            pinned_at: "2026-01-01T00:00:00Z".into(),
        };
        std::fs::write(d.join(TRUST_ANCHOR_FILENAME), serde_json::to_string(&anchor).unwrap()).unwrap();
        assert_eq!(
            import_enrollment_response(&d, &resp.to_json().unwrap(), INSTALL_B, Some(&s.root_fp()), Some(&req.request_id)).unwrap_err(),
            ERR_ANCHOR_CONFLICT,
            "A10: same fingerprint, different branch → refused (the new branch field)"
        );
        // The pre-pinned anchor is untouched.
        assert_eq!(load_trust_anchor(&d).unwrap().unwrap().branch_id, "branch-other");
    }

    // ── A11: a pinned anchor for the right root but the WRONG generation ─────
    #[test]
    fn a11_anchor_right_root_wrong_generation_is_refused() {
        let (s, d, req, resp) = enrolled_pair();
        let anchor = TrustAnchor {
            format_version: IDENTITY_FORMAT_VERSION,
            tenant_id: "tenant-1".into(),
            branch_id: "branch-main".into(),
            root_key_id: s.root.root_key_id.clone(),
            root_public_key: s.root.public_key.clone(),
            root_fingerprint: s.root.fingerprint.clone(),
            root_generation: s.root.generation + 1, // contradictory generation
            pinned_at: "2026-01-01T00:00:00Z".into(),
        };
        std::fs::write(d.join(TRUST_ANCHOR_FILENAME), serde_json::to_string(&anchor).unwrap()).unwrap();
        assert_eq!(
            import_enrollment_response(&d, &resp.to_json().unwrap(), INSTALL_B, Some(&s.root_fp()), Some(&req.request_id)).unwrap_err(),
            ERR_ANCHOR_CONFLICT,
            "A11: same key, contradictory generation → no silent rotation"
        );
    }

    // ── A12: the expected fingerprint is a separate input, never the response's
    #[test]
    fn a12_response_fingerprint_alone_is_not_trusted() {
        let (_s, d, req, resp) = enrolled_pair();
        let raw = resp.to_json().unwrap();
        // No out-of-band value → refused, even though the response carries a valid fingerprint.
        assert_eq!(
            import_enrollment_response(&d, &raw, INSTALL_B, None, Some(&req.request_id)).unwrap_err(),
            ERR_ROOT_FINGERPRINT_REQUIRED,
        );
        // A WRONG out-of-band value → refused (proves the parameter is actually checked).
        assert_eq!(
            import_enrollment_response(&d, &raw, INSTALL_B, Some(&"0".repeat(FINGERPRINT_HEX_LEN)), Some(&req.request_id)).unwrap_err(),
            ERR_ROOT_FINGERPRINT_MISMATCH,
        );
        assert!(!trust_anchor_exists(&d), "neither attempt pinned anything");
    }

    // ── §7 — a signed-approval response needs a LOCAL request to answer ───────
    #[test]
    fn import_without_a_local_request_is_refused() {
        let (s, d, req, resp) = enrolled_pair();
        std::fs::remove_file(d.join(REQUEST_FILENAME)).unwrap();
        assert_eq!(
            import_enrollment_response(&d, &resp.to_json().unwrap(), INSTALL_B, Some(&s.root_fp()), Some(&req.request_id)).unwrap_err(),
            ERR_REQUEST_MISSING,
        );
    }

    // ── §7 — the approval's nonce is checked against the LOCAL request, not the
    //    response ──────────────────────────────────────────────────────────────
    #[test]
    fn the_approval_is_bound_to_the_local_request_nonce() {
        let (s, d, req, resp) = enrolled_pair();
        // Replace the stored request with a different one (fresh nonce) for the same device.
        let key = load_identity(&d).unwrap();
        let other = create_enrollment_request(
            &key, INSTALL_B, "tenant-1", "branch-main", "client", &["sync".to_string()], 1, 3,
        )
        .unwrap();
        assert_ne!(other.request_nonce, req.request_nonce);
        store_enrollment_request(&d, &other).unwrap();
        assert_eq!(
            import_forged(&d, &resp, Some(&s.root_fp())).unwrap_err(),
            ERR_APPROVAL_MISMATCH,
            "the approval answers `req`; the local request is now `other` → nonce mismatch"
        );
    }

    // ── §7 — a malformed approval blob is refused ────────────────────────────
    #[test]
    fn a_malformed_approval_is_refused() {
        let (s, d, _req, resp) = enrolled_pair();
        let mut bad = resp.clone();
        bad.approval = "{not json".into();
        assert_eq!(import_forged(&d, &bad, Some(&s.root_fp())).unwrap_err(), ERR_APPROVAL_INVALID);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // M6-B2DE2 §5 — the trust anchor: idempotent, branch-bound, fail-closed,
    // and re-checkable later.
    // ═══════════════════════════════════════════════════════════════════════

    // ── an identical anchor is idempotent; a different fingerprint fails ──────
    #[test]
    fn anchor_is_idempotent_and_a_different_root_fails_closed() {
        let (s, d, req, resp) = enrolled_pair();
        let raw = resp.to_json().unwrap();
        import_enrollment_response(&d, &raw, INSTALL_B, Some(&s.root_fp()), Some(&req.request_id)).unwrap();
        let pinned = load_trust_anchor(&d).unwrap().unwrap();
        assert_eq!(pinned.branch_id, "branch-main");
        // Same bytes again → idempotent, anchor unchanged.
        import_enrollment_response(&d, &raw, INSTALL_B, Some(&s.root_fp()), Some(&req.request_id)).unwrap();
        assert_eq!(load_trust_anchor(&d).unwrap().unwrap(), pinned);
        // A different root's fingerprint confirmed against the SAME device → anchor conflict,
        // pin untouched (this is E9's property, restated for the branch-carrying anchor).
        begin_reenrollment(&s.conn, &req.device_id, &s.owner).unwrap();
        let s2 = server();
        let (_c2, foreign) = {
            let key = load_identity(&d).unwrap();
            let req2 = create_enrollment_request(&key, INSTALL_B, "tenant-1", "branch-main", "client", &["sync".to_string()], 1, 3).unwrap();
            store_enrollment_request(&d, &req2).unwrap();
            s2.approve(&req2).unwrap()
        };
        assert_eq!(
            import_enrollment_response(&d, &foreign.to_json().unwrap(), INSTALL_B, Some(&s2.root_fp()), None).unwrap_err(),
            ERR_ANCHOR_CONFLICT,
        );
        assert_eq!(load_trust_anchor(&d).unwrap().unwrap(), pinned, "no silent root rotation");
    }

    // ── §5 the later check: the stored cert re-verifies against the anchor ───
    #[test]
    fn a_stored_certificate_reverifies_against_the_pinned_anchor() {
        let (s, d, req, resp) = enrolled_pair();
        // Before enrollment: no anchor, no cert → the later check cannot pass.
        assert!(verify_certificate_against_anchor(&d).is_err());
        import_enrollment_response(&d, &resp.to_json().unwrap(), INSTALL_B, Some(&s.root_fp()), Some(&req.request_id)).unwrap();
        // After: the stored certificate verifies against the pinned root, same six fields.
        assert!(verify_certificate_against_anchor(&d).is_ok());
        // Corrupt the anchor's branch on disk → the later check refuses (contradiction), it does
        // not silently accept.
        let mut a = load_trust_anchor(&d).unwrap().unwrap();
        a.branch_id = "branch-elsewhere".into();
        std::fs::write(d.join(TRUST_ANCHOR_FILENAME), serde_json::to_string(&a).unwrap()).unwrap();
        assert_eq!(verify_certificate_against_anchor(&d).unwrap_err(), ERR_ANCHOR_CONFLICT);
    }

    // ── §6 — repo-wide proof: the out-of-band fingerprint is a separate input,
    //    never read back from the response ─────────────────────────────────────
    #[test]
    fn fingerprint_is_a_separate_parameter_with_no_response_fallback() {
        // Executable lines only (comments filtered). The forbidden needles are BUILT from
        // fragments so the full pattern never appears literally in this test's own source —
        // otherwise the scan would match itself (the recursive source-scan trap: even slicing at
        // `#[cfg(test)]` fails, because that marker also appears as a literal in the scanner).
        let strip = |src: &str| -> String {
            src.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n")
        };
        let code = strip(include_str!("device.rs"));
        assert!(
            code.contains("expected_root_fingerprint: Option<&str>"),
            "import takes the fingerprint as its own parameter"
        );
        let field = "expected_root_fingerprint";
        let resp_fp = "resp.tenant_root_fingerprint";
        let forbidden = [
            format!("{field}.unwrap_or({resp_fp}"),
            format!("{field} = {resp_fp}"),
            format!("{field}: {resp_fp}"),
            format!("unwrap_or(&{resp_fp}"),
            format!("unwrap_or({resp_fp}"),
        ];
        for f in &forbidden {
            assert!(
                !code.contains(f.as_str()),
                "no silent fallback to the response fingerprint: {f}"
            );
        }
        // The Tauri command exposes it as a separate parameter too.
        let libcode = strip(include_str!("../lib.rs"));
        assert!(
            libcode.contains("expected_root_fingerprint: Option<String>"),
            "the command surfaces the out-of-band fingerprint as its own parameter"
        );
        // Counter-assert: the scan still sees real executable code (guards against a filter that
        // makes the whole check vacuous).
        assert!(code.contains("ERR_ROOT_FINGERPRINT_REQUIRED"), "filter must still see code");
    }

    // ── §19: tests never touch production paths ──────────────────────────────
    #[test]
    fn tests_never_use_production_appdata() {
        let d = tmp_dir();
        let s = d.to_string_lossy().to_lowercase();
        assert!(s.contains("com.lataif.m6b2dtest"), "isolated identifier");
        assert!(!s.contains("roaming\\com.lataif.app"));
        assert!(!s.contains("roaming/com.lataif.app"));
    }
}
