//! M6-B2C4 — root custody and the two-phase authority transfer.
//!
//! ## The gap this closes
//!
//! B2C shipped a "transfer" that signed a certificate naming the target, superseded the
//! source's certificate, and inserted the target's as active — all on the source machine,
//! in one step. Two things were wrong with it.
//!
//! **It moved the claim, not the ability.** A certificate is a *statement about* the tenant
//! root: "installation X is the authority". Signing it needs the private root key, which
//! never left the source. The target ended up holding a perfectly valid certificate and no
//! way to sign anything with it.
//!
//! **It had no point of no return.** Source-stops and target-starts happened in the same
//! breath, so there was no state to crash in — which is another way of saying every crash
//! landed somewhere undefined. A handover between two machines cannot be atomic; the best
//! available is a well-defined order with a single irreversible step in the middle.
//!
//! ## The shape
//!
//! ```text
//! T1 issue      source: sign target cert, seal secrets, write package   → issued_pending
//! T2 import     target: decrypt, verify, store PENDING key              → target_imported
//! T3 receipt    target: HMAC over the receipt secret from the package   → target_confirmed
//! T4 confirm    source: verify the receipt                              → target_confirmed
//! T5 commit     source: retire own custody, supersede own certificate   → committed  ◄ POINT OF NO RETURN
//! T6 token      source: hand out the commit secret                      → (re-exportable)
//! T7 activate   target: publish key, activate custody + certificate     → target_activated
//! ```
//!
//! Between T5 and T7 **nobody can sign**. That is the correct failure mode: the source has
//! provably stopped and the target has provably not started. The alternative — an overlap —
//! is two live authorities, which is the thing this whole line of work exists to prevent.
//!
//! ## What the receipt does and does not prove
//!
//! The target proves it imported the package by returning an HMAC keyed on the
//! `receipt_secret` — which travelled **inside** the encrypted package. So the receipt
//! proves: someone knew the passphrase, decrypted the package, ran our import path, and
//! holds the target's install id.
//!
//! It does **not** prove a device identity. There is no device keypair in this slice (it is
//! explicitly out of scope), so the "proof" is the target replaying a secret we handed it.
//! A malicious local administrator on the target can extract that secret and forge the
//! receipt. This is why the confirmation level is spelled
//! `locally_confirmed_not_device_attested` — in the code, in the DB CHECK constraint, and in
//! the receipt itself. A shorter name would be a lie told by an identifier.
//!
//! ## Deliberately NOT here
//!
//! No device keypair, no device register, no CAS/bootstrap/snapshot, no cutover. `/sync/push`
//! remains gated by B2A's `may_write_sync()` alone — nothing in this module is consulted by
//! it.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use super::authority::{self, AuthorityCertificate};
use super::canonical::{self, sha256_hex, CanonicalWriter};
use super::primary::OwnerAuth;
use super::trust_root::{self, RootKey, TrustRootRecord};

pub const TRANSFER_FORMAT_VERSION: u32 = 1;
pub const TRANSFER_FILENAME: &str = "authority-transfer.lataif";

// ── Purposes. Every file this module reads or writes says what it is FOR, and the
// purpose is bound into the AEAD / MAC so it cannot be edited afterwards.
pub const PURPOSE_TRANSFER: &str = "authority_transfer";
pub const PURPOSE_RECEIPT: &str = "authority_transfer_receipt";
pub const PURPOSE_COMMIT: &str = "authority_transfer_commit";
pub const PURPOSE_ABORT: &str = "authority_transfer_abort";
/// The sibling format, recognised BY NAME so a recovery bundle replayed into the transfer
/// importer is refused explicitly rather than by accident.
pub const PURPOSE_RECOVERY: &str = super::recovery::PURPOSE_RECOVERY;

/// The ONLY value `confirmation_level` may take. See the module docs: a receipt made with a
/// secret we shipped inside the package cannot attest a device, and this name is the honest
/// description of what it does prove.
pub const CONFIRMATION_LEVEL: &str = "locally_confirmed_not_device_attested";

/// The owner must type this to hand the tenant's signing ability to another machine.
pub const TRANSFER_CONFIRMATION: &str = "TRANSFER_AUTHORITY_TO_THE_TARGET_INSTALLATION";

// ── §12 — hard structural limits, all checked BEFORE any expensive KDF.
pub const MAX_TRANSFER_BYTES: usize = 64 * 1024;
pub const MAX_TOKEN_BYTES: usize = 8 * 1024;
pub const MAX_RECEIPT_BYTES: usize = 8 * 1024;
pub const MAX_ID_LEN: usize = 64;
pub const MAX_TIMESTAMP_LEN: usize = 64;
pub const HASH_HEX_LEN: usize = 64;
/// base64 of 32 raw bytes (secret, MAC, sealed payload without tag).
pub const SECRET_B64_LEN: usize = 44;
/// HMAC-SHA256 is 32 bytes → 44 base64 chars.
pub const MAC_B64_LEN: usize = 44;
pub const NONCE_LEN: usize = 12;
pub const SALT_LEN: usize = 16;
pub const SECRET_LEN: usize = 32;
/// The sealed plaintext is one 32-byte secret; +16 for the GCM tag.
pub const SEALED_LEN: usize = SECRET_LEN + 16;
/// The package's plaintext is exactly `private_root_seed ‖ receipt_secret`, 32 + 32; +16 tag.
///
/// A FIXED layout, not JSON. §12 demands an exact ciphertext length, and a JSON plaintext
/// has no fixed length — so the requirement itself rules JSON out. It is also strictly
/// stronger than `deny_unknown_fields`: there are no fields to add, no parser to confuse,
/// and nothing to allocate based on attacker-influenced input. The "strict parser" for this
/// payload is the exact length check plus the public-key/fingerprint consistency check that
/// follows decryption.
pub const TRANSFER_PLAINTEXT_LEN: usize = SECRET_LEN + SECRET_LEN;
pub const TRANSFER_CIPHERTEXT_LEN: usize = TRANSFER_PLAINTEXT_LEN + 16;

pub const KDF_ARGON2ID: &str = "argon2id";
pub const AEAD_AES_256_GCM: &str = "aes-256-gcm";

// ── Error codes ─────────────────────────────────────────────────────────────
pub const ERR_TRANSFER_INVALID: &str = "AUTHORITY_TRANSFER_INVALID";
pub const ERR_TRANSFER_WRONG_PURPOSE: &str = "AUTHORITY_TRANSFER_WRONG_PURPOSE";
pub const ERR_TRANSFER_WRONG_TARGET: &str = "AUTHORITY_TRANSFER_WRONG_TARGET";
pub const ERR_TRANSFER_WRONG_TENANT: &str = "AUTHORITY_TRANSFER_WRONG_TENANT";
pub const ERR_TRANSFER_NOT_FOUND: &str = "AUTHORITY_TRANSFER_NOT_FOUND";
pub const ERR_TRANSFER_STATE: &str = "AUTHORITY_TRANSFER_INVALID_STATE";
pub const ERR_TRANSFER_ALREADY_COMMITTED: &str = "AUTHORITY_TRANSFER_ALREADY_COMMITTED";
pub const ERR_TRANSFER_IN_FLIGHT: &str = "AUTHORITY_TRANSFER_ALREADY_IN_FLIGHT";
pub const ERR_TRANSFER_NOT_CONFIRMED: &str = "AUTHORITY_TRANSFER_NOT_CONFIRMED";
pub const ERR_TRANSFER_CONFLICT: &str = "AUTHORITY_TRANSFER_CONFLICT";
pub const ERR_RECEIPT_INVALID: &str = "AUTHORITY_TRANSFER_RECEIPT_INVALID";
pub const ERR_TOKEN_INVALID: &str = "AUTHORITY_TRANSFER_TOKEN_INVALID";
pub const ERR_NOT_CONFIRMED: &str = "AUTHORITY_TRANSFER_NOT_CONFIRMED_BY_OWNER";
pub const ERR_PASSWORD_TOO_WEAK: &str = "TRANSFER_PASSWORD_TOO_WEAK";
pub const ERR_PASSWORD_MISMATCH: &str = "TRANSFER_PASSWORD_MISMATCH";
/// §9 — the local custody is retired (this machine committed a transfer away).
pub const ERR_CUSTODY_RETIRED: &str = "AUTHORITY_CUSTODY_RETIRED";
/// §9 — the local custody has not been activated yet (target before its commit token).
pub const ERR_CUSTODY_PENDING: &str = "AUTHORITY_CUSTODY_PENDING";
pub const ERR_CUSTODY_MISSING: &str = "AUTHORITY_CUSTODY_MISSING";

pub const MIN_TRANSFER_PASSWORD_LEN: usize = 12;

// ── States ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferState {
    IssuedPending,
    TargetImported,
    TargetConfirmed,
    Committed,
    TargetActivated,
    Aborted,
    Invalid,
}

impl TransferState {
    pub fn as_str(self) -> &'static str {
        match self {
            TransferState::IssuedPending => "issued_pending",
            TransferState::TargetImported => "target_imported",
            TransferState::TargetConfirmed => "target_confirmed",
            TransferState::Committed => "committed",
            TransferState::TargetActivated => "target_activated",
            TransferState::Aborted => "aborted",
            TransferState::Invalid => "invalid",
        }
    }
    pub fn parse(s: &str) -> Option<TransferState> {
        Some(match s {
            "issued_pending" => TransferState::IssuedPending,
            "target_imported" => TransferState::TargetImported,
            "target_confirmed" => TransferState::TargetConfirmed,
            "committed" => TransferState::Committed,
            "target_activated" => TransferState::TargetActivated,
            "aborted" => TransferState::Aborted,
            "invalid" => TransferState::Invalid,
            _ => return None,
        })
    }
    /// §10 — abort is only possible BEFORE the source commits. After that the source has
    /// already stopped being the authority; "undoing" it would mean re-activating a custody
    /// that a target may already have taken over.
    pub fn may_abort(self) -> bool {
        matches!(
            self,
            TransferState::IssuedPending | TransferState::TargetImported | TransferState::TargetConfirmed
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CustodyState {
    SourceActive,
    TargetPending,
    TargetActive,
    SourceRetired,
    Aborted,
    Invalid,
}

impl CustodyState {
    pub fn as_str(self) -> &'static str {
        match self {
            CustodyState::SourceActive => "source_active",
            CustodyState::TargetPending => "target_pending",
            CustodyState::TargetActive => "target_active",
            CustodyState::SourceRetired => "source_retired",
            CustodyState::Aborted => "aborted",
            CustodyState::Invalid => "invalid",
        }
    }
    pub fn parse(s: &str) -> Option<CustodyState> {
        Some(match s {
            "source_active" => CustodyState::SourceActive,
            "target_pending" => CustodyState::TargetPending,
            "target_active" => CustodyState::TargetActive,
            "source_retired" => CustodyState::SourceRetired,
            "aborted" => CustodyState::Aborted,
            "invalid" => CustodyState::Invalid,
            _ => return None,
        })
    }
    /// The single question §9's gate asks. Only two of six states may sign, and the four
    /// that may not are exactly the interesting ones: pending (not yet), retired (no
    /// longer), aborted, invalid.
    pub fn may_sign(self) -> bool {
        matches!(self, CustodyState::SourceActive | CustodyState::TargetActive)
    }
}

// ── Secrets ─────────────────────────────────────────────────────────────────

/// A 32-byte secret that wipes itself. Never `Clone`, never `Debug`-printable.
pub(crate) struct Secret32([u8; SECRET_LEN]);

impl Drop for Secret32 {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl std::fmt::Debug for Secret32 {
    /// §14 T20 — a secret must not be able to reach a log through a derived `Debug`.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Secret32(<redacted>)")
    }
}

impl Secret32 {
    fn random() -> Result<Secret32, &'static str> {
        use rand::RngCore;
        let mut b = [0u8; SECRET_LEN];
        // `try_fill_bytes`, not `fill_bytes`: an entropy failure must be an error, never a
        // silently predictable secret.
        rand::rngs::OsRng.try_fill_bytes(&mut b).map_err(|_| ERR_TRANSFER_INVALID)?;
        Ok(Secret32(b))
    }
    fn from_slice(b: &[u8]) -> Result<Secret32, &'static str> {
        let arr: [u8; SECRET_LEN] = b.try_into().map_err(|_| ERR_TRANSFER_INVALID)?;
        Ok(Secret32(arr))
    }
    fn as_bytes(&self) -> &[u8; SECRET_LEN] {
        &self.0
    }
    fn to_b64(&self) -> String {
        b64(&self.0)
    }
    fn from_b64(s: &str) -> Result<Secret32, &'static str> {
        Secret32::from_slice(&unb64(s)?)
    }
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(s: &str) -> Result<Vec<u8>, &'static str> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).map_err(|_| ERR_TRANSFER_INVALID)
}

// ── §5 — commitments ────────────────────────────────────────────────────────

/// The hash the package carries instead of the secret itself.
///
/// Domain-bound: commit and abort hash under DIFFERENT separators over the same fields, so
/// an abort token — which the source hands out freely when it cancels — can never be
/// replayed as the commit token that activates a target.
fn commitment(
    domain: &[u8],
    transfer_id: &str,
    target_install_id: &str,
    target_authority_id: &str,
    target_certificate_hash: &str,
    secret: &Secret32,
) -> String {
    let mut w = CanonicalWriter::new(domain, TRANSFER_FORMAT_VERSION);
    w.string(transfer_id)
        .string(target_install_id)
        .string(target_authority_id)
        .string(target_certificate_hash)
        .bytes(secret.as_bytes());
    sha256_hex(&w.finish())
}

// ── §5 — sealing the source's commit/abort secrets at rest ──────────────────

/// HKDF-SHA256(root_seed) → a wrapping key bound to this transfer.
///
/// The IKM is the tenant root seed, so the sealed secrets are only recoverable on a machine
/// that holds the root — a stolen DB file alone cannot commit anything. `info` carries the
/// domain and the transfer id, so two transfers never share a wrapping key. No salt: the
/// IKM is already 256 bits of CSPRNG output, which is the documented case for omitting it.
fn seal_key(root_seed: &[u8; 32], transfer_id: &str) -> Result<Secret32, &'static str> {
    let mut info = CanonicalWriter::new(canonical::DOMAIN_TRANSFER_SEAL, TRANSFER_FORMAT_VERSION);
    info.string(transfer_id);
    let hk = hkdf::Hkdf::<sha2::Sha256>::new(None, root_seed);
    let mut out = [0u8; 32];
    hk.expand(&info.finish(), &mut out).map_err(|_| ERR_TRANSFER_INVALID)?;
    Ok(Secret32(out))
}

/// AAD for a sealed secret. `secret_purpose` is what stops a sealed ABORT secret from being
/// unsealed as the COMMIT secret: same key, same transfer, different associated data ⇒ the
/// tag fails.
fn seal_aad(
    transfer_id: &str,
    secret_purpose: &str,
    source_authority_id: &str,
    target_authority_id: &str,
    target_install_id: &str,
) -> Vec<u8> {
    let mut w = CanonicalWriter::new(canonical::DOMAIN_TRANSFER_SEAL, TRANSFER_FORMAT_VERSION);
    w.string(transfer_id)
        .string(secret_purpose)
        .string(source_authority_id)
        .string(target_authority_id)
        .string(target_install_id);
    w.finish()
}

fn aes_seal(key: &Secret32, nonce: &[u8], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, &'static str> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(key.as_bytes()).map_err(|_| ERR_TRANSFER_INVALID)?;
    cipher
        .encrypt(aes_gcm::Nonce::from_slice(nonce), Payload { msg: plaintext, aad })
        .map_err(|_| ERR_TRANSFER_INVALID)
}

fn aes_open(key: &Secret32, nonce: &[u8], aad: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, &'static str> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    if nonce.len() != NONCE_LEN {
        return Err(ERR_TRANSFER_INVALID);
    }
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(key.as_bytes()).map_err(|_| ERR_TRANSFER_INVALID)?;
    cipher
        .decrypt(aes_gcm::Nonce::from_slice(nonce), Payload { msg: ciphertext, aad })
        .map_err(|_| ERR_TRANSFER_INVALID)
}

fn random_bytes(n: usize) -> Result<Vec<u8>, &'static str> {
    use rand::RngCore;
    let mut v = vec![0u8; n];
    rand::rngs::OsRng.try_fill_bytes(&mut v).map_err(|_| ERR_TRANSFER_INVALID)?;
    Ok(v)
}

/// Seal one secret under the root-derived wrapping key. Returns (ciphertext_b64, nonce_b64).
fn seal_secret(
    root_seed: &[u8; 32],
    rec: &TransferRecord,
    secret_purpose: &str,
    secret: &Secret32,
) -> Result<(String, String), &'static str> {
    let key = seal_key(root_seed, &rec.transfer_id)?;
    let nonce = random_bytes(NONCE_LEN)?;
    let aad = seal_aad(
        &rec.transfer_id,
        secret_purpose,
        &rec.source_authority_id,
        &rec.target_authority_id,
        &rec.target_install_id,
    );
    let ct = aes_seal(&key, &nonce, &aad, secret.as_bytes())?;
    Ok((b64(&ct), b64(&nonce)))
}

fn open_secret(
    root_seed: &[u8; 32],
    rec: &TransferRecord,
    secret_purpose: &str,
    sealed_b64: &str,
    nonce_b64: &str,
) -> Result<Secret32, &'static str> {
    let key = seal_key(root_seed, &rec.transfer_id)?;
    let aad = seal_aad(
        &rec.transfer_id,
        secret_purpose,
        &rec.source_authority_id,
        &rec.target_authority_id,
        &rec.target_install_id,
    );
    let ct = unb64(sealed_b64)?;
    if ct.len() != SEALED_LEN {
        return Err(ERR_TRANSFER_INVALID);
    }
    let mut pt = aes_open(&key, &unb64(nonce_b64)?, &aad, &ct)?;
    let s = Secret32::from_slice(&pt);
    pt.zeroize();
    s
}

// ── §4 — the transfer package ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct KdfParameters {
    pub m_cost_kib: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

/// `authority-transfer.lataif`, exactly as written to disk.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TransferBundle {
    pub format_version: u32,
    pub purpose: String,
    pub transfer_id: String,

    pub tenant_id: String,
    pub branch_id: String,

    pub root_key_id: String,
    pub root_generation: i64,

    pub source_authority_id: String,
    pub target_authority_id: String,
    pub source_install_id: String,
    pub target_install_id: String,

    /// The target's certificate, signed but not active anywhere yet.
    pub target_authority_certificate: String,
    pub target_certificate_hash: String,

    /// Commitments only — the secrets themselves are NOT in this file.
    pub commit_secret_hash: String,
    pub abort_secret_hash: String,

    pub kdf: String,
    pub kdf_parameters: KdfParameters,
    pub salt: String,
    pub encryption_algorithm: String,
    pub nonce: String,
    /// AES-256-GCM over `private_root_seed ‖ receipt_secret`.
    pub ciphertext: String,
    pub checksum: String,
    pub created_at: String,
}

impl TransferBundle {
    fn checksum_input(&self) -> Vec<u8> {
        let mut copy = self.clone();
        copy.checksum = String::new();
        serde_json::to_vec(&copy).unwrap_or_default()
    }

    fn compute_checksum(&self) -> String {
        sha256_hex(&self.checksum_input())
    }

    /// The AEAD's associated data — `canonical_bytes_v1`, domain `TRANSFER-BUNDLE-AAD`.
    ///
    /// Everything that identifies WHERE this key may go is in here. Rewriting
    /// `target_install_id` to point at another machine does not produce a package that
    /// decrypts elsewhere; it produces one that does not decrypt at all. The checksum
    /// cannot do that job — anyone can recompute a checksum.
    fn aad(&self) -> Vec<u8> {
        let mut w =
            CanonicalWriter::new(canonical::DOMAIN_TRANSFER_BUNDLE_AAD, self.format_version);
        w.string(&self.purpose)
            .string(&self.transfer_id)
            .string(&self.tenant_id)
            .string(&self.branch_id)
            .string(&self.root_key_id)
            .i64(self.root_generation)
            .string(&self.source_authority_id)
            .string(&self.target_authority_id)
            .string(&self.source_install_id)
            .string(&self.target_install_id)
            .string(&self.target_certificate_hash)
            .string(&self.commit_secret_hash)
            .string(&self.abort_secret_hash);
        w.finish()
    }

    pub fn to_json(&self) -> Result<String, &'static str> {
        serde_json::to_string_pretty(self).map_err(|_| ERR_TRANSFER_INVALID)
    }

    /// §12 — strict. Size cap first, then structure, and only then anything expensive.
    pub fn from_json(raw: &str) -> Result<TransferBundle, &'static str> {
        if raw.len() > MAX_TRANSFER_BYTES {
            return Err(ERR_TRANSFER_INVALID);
        }
        let b: TransferBundle = serde_json::from_str(raw).map_err(|_| ERR_TRANSFER_INVALID)?;
        validate_bundle_structure(&b)?;
        Ok(b)
    }
}

/// §12 — every structural bound in one place, checked BEFORE the deliberately expensive KDF.
///
/// Argon2id at 64 MiB × 3 is a memory and time cost we must never pay for a file that was
/// never ours to begin with.
fn validate_bundle_structure(b: &TransferBundle) -> Result<(), &'static str> {
    if b.format_version != TRANSFER_FORMAT_VERSION {
        return Err(ERR_TRANSFER_INVALID);
    }
    // The sibling format is named and refused explicitly. Both branches return the same
    // code, but the distinction is what tells a future reader the two formats exist and are
    // deliberately not interchangeable.
    if b.purpose == PURPOSE_RECOVERY {
        eprintln!("[transfer] import refused: this file is a tenant-root recovery bundle");
        return Err(ERR_TRANSFER_WRONG_PURPOSE);
    }
    if b.purpose != PURPOSE_TRANSFER {
        return Err(ERR_TRANSFER_WRONG_PURPOSE);
    }
    if b.encryption_algorithm != AEAD_AES_256_GCM {
        return Err(ERR_TRANSFER_INVALID);
    }
    if b.root_generation < 1 {
        return Err(ERR_TRANSFER_INVALID);
    }
    for s in [
        &b.transfer_id,
        &b.tenant_id,
        &b.branch_id,
        &b.root_key_id,
        &b.source_authority_id,
        &b.target_authority_id,
        &b.source_install_id,
        &b.target_install_id,
    ] {
        if s.is_empty() || s.len() > MAX_ID_LEN {
            return Err(ERR_TRANSFER_INVALID);
        }
    }
    // A package that hands a machine its own custody back is a no-op that ends with the
    // source retired and nothing active.
    if b.source_install_id == b.target_install_id {
        return Err(ERR_TRANSFER_INVALID);
    }
    if b.created_at.len() > MAX_TIMESTAMP_LEN {
        return Err(ERR_TRANSFER_INVALID);
    }
    for h in [&b.target_certificate_hash, &b.commit_secret_hash, &b.abort_secret_hash, &b.checksum] {
        if h.len() != HASH_HEX_LEN || !h.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(ERR_TRANSFER_INVALID);
        }
    }
    // Commit and abort must be DIFFERENT secrets. Equal commitments mean one secret was
    // used for both, and then the abort token the source hands out on cancellation would
    // also commit the transfer.
    if b.commit_secret_hash == b.abort_secret_hash {
        return Err(ERR_TRANSFER_INVALID);
    }
    if b.target_authority_certificate.len() > authority::MAX_CERTIFICATE_BYTES {
        return Err(ERR_TRANSFER_INVALID);
    }
    // Exact encodings. These are fixed by the algorithms, so anything else was not ours.
    if unb64(&b.salt)?.len() != SALT_LEN {
        return Err(ERR_TRANSFER_INVALID);
    }
    if unb64(&b.nonce)?.len() != NONCE_LEN {
        return Err(ERR_TRANSFER_INVALID);
    }
    if unb64(&b.ciphertext)?.len() != TRANSFER_CIPHERTEXT_LEN {
        return Err(ERR_TRANSFER_INVALID);
    }
    validate_kdf(&b.kdf, &b.kdf_parameters)?;
    Ok(())
}

/// Both ends of every KDF parameter matter. Too low is the obvious attack (a package
/// claiming m=8 KiB is trivially brute-forcible). Too high is the quieter one: an
/// attacker-supplied `m_cost = 16 GiB` is a memory bomb we would dutifully allocate before
/// ever checking the passphrase.
fn validate_kdf(kdf: &str, p: &KdfParameters) -> Result<(), &'static str> {
    use super::recovery::{
        MAX_M_COST_KIB, MAX_P_COST, MAX_T_COST, MIN_M_COST_KIB, MIN_P_COST, MIN_T_COST,
    };
    if kdf != KDF_ARGON2ID {
        return Err(ERR_TRANSFER_INVALID);
    }
    if p.m_cost_kib < MIN_M_COST_KIB || p.m_cost_kib > MAX_M_COST_KIB {
        return Err(ERR_TRANSFER_INVALID);
    }
    if p.t_cost < MIN_T_COST || p.t_cost > MAX_T_COST {
        return Err(ERR_TRANSFER_INVALID);
    }
    if p.p_cost < MIN_P_COST || p.p_cost > MAX_P_COST {
        return Err(ERR_TRANSFER_INVALID);
    }
    Ok(())
}

fn derive_key(password: &str, salt: &[u8], p: &KdfParameters) -> Result<Secret32, &'static str> {
    let params = argon2::Params::new(p.m_cost_kib, p.t_cost, p.p_cost, Some(32))
        .map_err(|_| ERR_TRANSFER_INVALID)?;
    let a2 = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut key = [0u8; 32];
    a2.hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|_| ERR_TRANSFER_INVALID)?;
    Ok(Secret32(key))
}

/// The passphrase protecting a package that leaves the building.
pub fn validate_transfer_password(password: &str, confirmation: &str) -> Result<(), &'static str> {
    if password.chars().count() < MIN_TRANSFER_PASSWORD_LEN {
        return Err(ERR_PASSWORD_TOO_WEAK);
    }
    if password != confirmation {
        return Err(ERR_PASSWORD_MISMATCH);
    }
    Ok(())
}

// ── §7 — the target receipt ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TargetReceipt {
    pub format_version: u32,
    pub purpose: String,
    pub transfer_id: String,
    pub target_install_id: String,
    pub target_authority_id: String,
    pub root_key_id: String,
    pub root_generation: i64,
    pub target_certificate_hash: String,
    pub imported_at: String,
    /// Always `CONFIRMATION_LEVEL`. Inside the MAC, so it cannot be upgraded after the fact.
    pub confirmation_level: String,
    /// base64 HMAC-SHA256 over `canonical()`, keyed with the package's receipt secret.
    pub mac: String,
}

impl TargetReceipt {
    /// The MAC'd bytes. Domain-separated from the commit token, so a receipt can never be
    /// mistaken for one.
    fn canonical(&self) -> Vec<u8> {
        let mut w = CanonicalWriter::new(canonical::DOMAIN_TRANSFER_RECEIPT, self.format_version);
        w.string(&self.purpose)
            .string(&self.transfer_id)
            .string(&self.target_install_id)
            .string(&self.target_authority_id)
            .string(&self.root_key_id)
            .i64(self.root_generation)
            .string(&self.target_certificate_hash)
            .string(&self.imported_at)
            .string(&self.confirmation_level);
        w.finish()
    }

    fn compute_mac(&self, secret: &Secret32) -> Result<String, &'static str> {
        use hmac::Mac;
        let mut m = <hmac::Hmac<sha2::Sha256>>::new_from_slice(secret.as_bytes())
            .map_err(|_| ERR_RECEIPT_INVALID)?;
        m.update(&self.canonical());
        Ok(b64(&m.finalize().into_bytes()))
    }

    /// Verify in constant time. `hmac`'s `verify_slice` is the constant-time comparison;
    /// a plain `==` on the base64 strings would leak the MAC one byte at a time.
    fn verify_mac(&self, secret: &Secret32) -> Result<(), &'static str> {
        use hmac::Mac;
        let mut m = <hmac::Hmac<sha2::Sha256>>::new_from_slice(secret.as_bytes())
            .map_err(|_| ERR_RECEIPT_INVALID)?;
        m.update(&self.canonical());
        let given = unb64(&self.mac).map_err(|_| ERR_RECEIPT_INVALID)?;
        m.verify_slice(&given).map_err(|_| ERR_RECEIPT_INVALID)
    }

    pub fn to_json(&self) -> Result<String, &'static str> {
        serde_json::to_string_pretty(self).map_err(|_| ERR_RECEIPT_INVALID)
    }

    pub fn from_json(raw: &str) -> Result<TargetReceipt, &'static str> {
        if raw.len() > MAX_RECEIPT_BYTES {
            return Err(ERR_RECEIPT_INVALID);
        }
        let r: TargetReceipt = serde_json::from_str(raw).map_err(|_| ERR_RECEIPT_INVALID)?;
        if r.format_version != TRANSFER_FORMAT_VERSION {
            return Err(ERR_RECEIPT_INVALID);
        }
        // A commit token replayed as a receipt, or the reverse, dies here — before the MAC
        // maths, and regardless of what key someone tried to key it with.
        if r.purpose != PURPOSE_RECEIPT {
            return Err(ERR_RECEIPT_INVALID);
        }
        // The honest level is the only one we accept. A receipt claiming
        // "device_attested" is a receipt from something that is not this code.
        if r.confirmation_level != CONFIRMATION_LEVEL {
            return Err(ERR_RECEIPT_INVALID);
        }
        for s in [
            &r.transfer_id,
            &r.target_install_id,
            &r.target_authority_id,
            &r.root_key_id,
        ] {
            if s.is_empty() || s.len() > MAX_ID_LEN {
                return Err(ERR_RECEIPT_INVALID);
            }
        }
        if r.imported_at.len() > MAX_TIMESTAMP_LEN {
            return Err(ERR_RECEIPT_INVALID);
        }
        if r.target_certificate_hash.len() != HASH_HEX_LEN
            || !r.target_certificate_hash.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err(ERR_RECEIPT_INVALID);
        }
        if r.root_generation < 1 {
            return Err(ERR_RECEIPT_INVALID);
        }
        if r.mac.len() != MAC_B64_LEN || unb64(&r.mac).map_err(|_| ERR_RECEIPT_INVALID)?.len() != 32 {
            return Err(ERR_RECEIPT_INVALID);
        }
        Ok(r)
    }
}

// ── §6/§10 — commit and abort tokens ────────────────────────────────────────

/// One shape for both tokens; the `purpose` and the commitment domain are what separate
/// them. Deliberately one type: two near-identical structs is how the two checks drift
/// apart, and "abort token accepted as commit" is exactly the drift that matters.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TransferToken {
    pub format_version: u32,
    pub purpose: String,
    pub transfer_id: String,
    /// base64 of the 32-byte secret. Revealing it IS the act — for commit, it is what
    /// allows the target to activate; for abort, what allows it to stand down.
    pub secret: String,
    /// `committed_at` for a commit token, `aborted_at` for an abort token.
    pub issued_at: String,
    pub target_certificate_hash: String,
}

impl TransferToken {
    pub fn to_json(&self) -> Result<String, &'static str> {
        serde_json::to_string_pretty(self).map_err(|_| ERR_TOKEN_INVALID)
    }

    /// §12 — strict, and `expect_purpose` is not optional. Every caller must say which
    /// token it wants, so "parse a token" can never be a step that happens before anyone
    /// decided what kind it should be.
    pub fn from_json(raw: &str, expect_purpose: &str) -> Result<TransferToken, &'static str> {
        if raw.len() > MAX_TOKEN_BYTES {
            return Err(ERR_TOKEN_INVALID);
        }
        let t: TransferToken = serde_json::from_str(raw).map_err(|_| ERR_TOKEN_INVALID)?;
        if t.format_version != TRANSFER_FORMAT_VERSION {
            return Err(ERR_TOKEN_INVALID);
        }
        if t.purpose != expect_purpose {
            return Err(ERR_TOKEN_INVALID);
        }
        if t.transfer_id.is_empty() || t.transfer_id.len() > MAX_ID_LEN {
            return Err(ERR_TOKEN_INVALID);
        }
        if t.issued_at.len() > MAX_TIMESTAMP_LEN {
            return Err(ERR_TOKEN_INVALID);
        }
        if t.target_certificate_hash.len() != HASH_HEX_LEN
            || !t.target_certificate_hash.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err(ERR_TOKEN_INVALID);
        }
        if t.secret.len() != SECRET_B64_LEN
            || unb64(&t.secret).map_err(|_| ERR_TOKEN_INVALID)?.len() != SECRET_LEN
        {
            return Err(ERR_TOKEN_INVALID);
        }
        Ok(t)
    }
}

// ── DB rows ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferRecord {
    pub transfer_id: String,
    pub tenant_id: String,
    pub branch_id: String,
    pub source_authority_id: String,
    pub target_authority_id: String,
    pub source_install_id: String,
    pub target_install_id: String,
    pub root_key_id: String,
    pub root_generation: i64,
    pub target_certificate: String,
    pub target_certificate_hash: String,
    pub commit_secret_hash: String,
    pub abort_secret_hash: String,
    pub state: TransferState,
    pub confirmation_level: Option<String>,
}

const TRANSFER_COLS: &str = "transfer_id, tenant_id, branch_id, source_authority_id, \
     target_authority_id, source_install_id, target_install_id, root_key_id, root_generation, \
     target_certificate, target_certificate_hash, commit_secret_hash, abort_secret_hash, \
     state, confirmation_level";

fn transfer_from_row(r: &rusqlite::Row) -> rusqlite::Result<TransferRecord> {
    let state: String = r.get(13)?;
    Ok(TransferRecord {
        transfer_id: r.get(0)?,
        tenant_id: r.get(1)?,
        branch_id: r.get(2)?,
        source_authority_id: r.get(3)?,
        target_authority_id: r.get(4)?,
        source_install_id: r.get(5)?,
        target_install_id: r.get(6)?,
        root_key_id: r.get(7)?,
        root_generation: r.get(8)?,
        target_certificate: r.get(9)?,
        target_certificate_hash: r.get(10)?,
        commit_secret_hash: r.get(11)?,
        abort_secret_hash: r.get(12)?,
        // An unparseable state is `Invalid`, never a default that happens to be permissive.
        state: TransferState::parse(&state).unwrap_or(TransferState::Invalid),
        confirmation_level: r.get(14)?,
    })
}

pub fn load_transfer(conn: &Connection, transfer_id: &str) -> Result<TransferRecord, &'static str> {
    conn.query_row(
        &format!("SELECT {TRANSFER_COLS} FROM authority_transfers WHERE transfer_id = ?1"),
        params![transfer_id],
        transfer_from_row,
    )
    .optional()
    .map_err(|_| ERR_TRANSFER_INVALID)?
    .ok_or(ERR_TRANSFER_NOT_FOUND)
}

/// The custody state of THIS installation for a tenant.
pub fn custody_state(
    conn: &Connection,
    tenant_id: &str,
    install_id: &str,
) -> Result<Option<CustodyState>, &'static str> {
    let s: Option<String> = conn
        .query_row(
            "SELECT state FROM root_custody WHERE tenant_id = ?1 AND install_id = ?2",
            params![tenant_id, install_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| ERR_TRANSFER_INVALID)?;
    Ok(s.map(|v| CustodyState::parse(&v).unwrap_or(CustodyState::Invalid)))
}

/// §9 — the custody half of the signing gate, in one place.
///
/// The distinction between the three refusals is the point. "Pending" means *not yet* — the
/// commit token has not arrived. "Retired" means *no longer* — this machine committed the
/// authority away. "Missing" means this installation was never in the custody chain at all.
/// Collapsing them into one error would make the two most common support questions
/// ("why can't the new machine sign?" / "why can't the old one?") indistinguishable.
pub fn require_custody(
    conn: &Connection,
    tenant_id: &str,
    install_id: &str,
) -> Result<CustodyState, &'static str> {
    match custody_state(conn, tenant_id, install_id)? {
        Some(s) if s.may_sign() => Ok(s),
        Some(CustodyState::TargetPending) => Err(ERR_CUSTODY_PENDING),
        Some(CustodyState::SourceRetired) => Err(ERR_CUSTODY_RETIRED),
        Some(CustodyState::Aborted) => Err(ERR_CUSTODY_PENDING),
        Some(CustodyState::Invalid) => Err(ERR_CUSTODY_MISSING),
        Some(_) => Err(ERR_CUSTODY_MISSING),
        None => Err(ERR_CUSTODY_MISSING),
    }
}

/// Record the founding custody: this install holds the root it just created.
///
/// Called from the trust-root initialization path. Without it, a tenant that created its
/// root before v0006 would have no custody row, and §9's gate would refuse to sign — the
/// gate is fail-closed by design, so the row has to exist.
pub fn record_founding_custody(
    conn: &Connection,
    root: &TrustRootRecord,
    install_id: &str,
) -> Result<(), &'static str> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR IGNORE INTO root_custody
           (tenant_id, root_key_id, root_generation, install_id, transfer_id, state,
            created_at, activated_at)
         VALUES (?1, ?2, ?3, ?4, NULL, 'source_active', ?5, ?5)",
        params![root.tenant_id, root.root_key_id, root.generation, install_id, now],
    )
    .map_err(|_| ERR_TRANSFER_INVALID)?;
    Ok(())
}

// ── §8 T1 — issue, on the source ────────────────────────────────────────────

/// What the source needs to prove before it may hand the tenant's root away.
///
/// No `app_data_dir`: T1 reads no file. The root key arrives as `key`, already loaded and
/// verified against the DB record by the caller's `require_signing_root`, so re-reading the
/// file here would be a second, weaker copy of that check.
pub struct IssueRequest<'a> {
    pub conn: &'a Connection,
    pub tenant_id: &'a str,
    pub branch_id: &'a str,
    pub install_id: &'a str,
    pub primary_state: super::primary::State,
    pub root: &'a TrustRootRecord,
    pub key: &'a RootKey,
    pub owner: &'a OwnerAuth,
}

/// T1 — create the transfer and the package. Nothing changes hands yet.
///
/// The source stays `source_active` and its certificate stays `active` for the whole of T1
/// through T4. That is deliberate and it is the difference from the old `issue_transfer`:
/// until the source commits, the shop keeps working on the source exactly as before, and an
/// abort is free.
pub fn issue(
    req: &IssueRequest,
    target_install_id: &str,
    passphrase: &str,
    passphrase_confirmation: &str,
    confirmation: &str,
) -> Result<(TransferBundle, TransferRecord), &'static str> {
    if confirmation != TRANSFER_CONFIRMATION {
        return Err(ERR_NOT_CONFIRMED);
    }
    validate_transfer_password(passphrase, passphrase_confirmation)?;

    let target = target_install_id.trim();
    if target.is_empty() || target.len() > MAX_ID_LEN {
        return Err(authority::ERR_TARGET_REQUIRED);
    }
    if target == req.install_id {
        return Err(ERR_TRANSFER_INVALID);
    }

    // §9 — the full signing gate. Primary, instance match, custody, and an active authority
    // that belongs to THIS install.
    let current = authority::require_signing_authority(
        req.conn,
        req.tenant_id,
        req.branch_id,
        req.install_id,
        req.primary_state,
        req.root,
    )?;

    // At most one transfer in flight. The DB's partial unique index is the real guard; this
    // is the legible error.
    let in_flight: i64 = req
        .conn
        .query_row(
            "SELECT COUNT(*) FROM authority_transfers
              WHERE tenant_id = ?1 AND branch_id = ?2
                AND state IN ('issued_pending','target_imported','target_confirmed','committed')",
            params![req.tenant_id, req.branch_id],
            |r| r.get(0),
        )
        .map_err(|_| ERR_TRANSFER_INVALID)?;
    if in_flight > 0 {
        return Err(ERR_TRANSFER_IN_FLIGHT);
    }

    let transfer_id = uuid::Uuid::new_v4().to_string();

    // The target's certificate is signed here but inserted NOWHERE. It lives in the
    // transfer record and the package until the target activates it (§8 T1).
    let cert = authority::sign_transfer_certificate(
        req.tenant_id,
        req.branch_id,
        req.root,
        req.key,
        current.authority_epoch + 1,
        target,
        Some(current.authority_id.clone()),
    )?;
    let cert_json = cert.to_json()?;
    let cert_hash = cert.payload.payload_hash();

    let rec = TransferRecord {
        transfer_id: transfer_id.clone(),
        tenant_id: req.tenant_id.to_string(),
        branch_id: req.branch_id.to_string(),
        source_authority_id: current.authority_id.clone(),
        target_authority_id: cert.payload.authority_id.clone(),
        source_install_id: req.install_id.to_string(),
        target_install_id: target.to_string(),
        root_key_id: req.root.root_key_id.clone(),
        root_generation: req.root.generation,
        target_certificate: cert_json.clone(),
        target_certificate_hash: cert_hash.clone(),
        commit_secret_hash: String::new(),
        abort_secret_hash: String::new(),
        state: TransferState::IssuedPending,
        confirmation_level: None,
    };

    // Three independent secrets. Independent is load-bearing: deriving abort from commit
    // (or either from the transfer id) would mean holding one is holding the other.
    let receipt_secret = Secret32::random()?;
    let commit_secret = Secret32::random()?;
    let abort_secret = Secret32::random()?;

    let commit_hash = commitment(
        canonical::DOMAIN_TRANSFER_COMMIT,
        &transfer_id,
        target,
        &cert.payload.authority_id,
        &cert_hash,
        &commit_secret,
    );
    let abort_hash = commitment(
        canonical::DOMAIN_TRANSFER_ABORT,
        &transfer_id,
        target,
        &cert.payload.authority_id,
        &cert_hash,
        &abort_secret,
    );
    let rec = TransferRecord { commit_secret_hash: commit_hash.clone(), abort_secret_hash: abort_hash.clone(), ..rec };

    // Seal the two secrets the package must NOT carry, so a crash can resume (§11) without
    // the DB file alone ever being enough to commit.
    let (sealed_commit, commit_nonce) =
        seal_secret(req.key.seed(), &rec, PURPOSE_COMMIT, &commit_secret)?;
    let (sealed_abort, abort_nonce) =
        seal_secret(req.key.seed(), &rec, PURPOSE_ABORT, &abort_secret)?;
    // The source must ALSO keep the receipt secret: T4 verifies the target's MAC with it,
    // and it is `random()`, not derived, so there is nothing to recompute later. Deriving it
    // from the root key instead would be the tempting shortcut and the wrong one — it would
    // stop being an independent secret, and the package would no longer be the only thing
    // that carries it. Same column as the target uses, which is not a collision: source and
    // target are different databases, each sealing its own copy under the same root seed.
    let (sealed_receipt, receipt_nonce) =
        seal_secret(req.key.seed(), &rec, PURPOSE_RECEIPT, &receipt_secret)?;

    // Build the package: root seed + receipt secret, under the owner's passphrase.
    let salt = random_bytes(SALT_LEN)?;
    let nonce = random_bytes(NONCE_LEN)?;
    let kdf_parameters = KdfParameters {
        m_cost_kib: super::recovery::ARGON2_M_COST_KIB,
        t_cost: super::recovery::ARGON2_T_COST,
        p_cost: super::recovery::ARGON2_P_COST,
    };

    let mut bundle = TransferBundle {
        format_version: TRANSFER_FORMAT_VERSION,
        purpose: PURPOSE_TRANSFER.to_string(),
        transfer_id: transfer_id.clone(),
        tenant_id: req.tenant_id.to_string(),
        branch_id: req.branch_id.to_string(),
        root_key_id: req.root.root_key_id.clone(),
        root_generation: req.root.generation,
        source_authority_id: current.authority_id.clone(),
        target_authority_id: cert.payload.authority_id.clone(),
        source_install_id: req.install_id.to_string(),
        target_install_id: target.to_string(),
        target_authority_certificate: cert_json,
        target_certificate_hash: cert_hash,
        commit_secret_hash: commit_hash,
        abort_secret_hash: abort_hash,
        kdf: KDF_ARGON2ID.to_string(),
        kdf_parameters,
        salt: b64(&salt),
        encryption_algorithm: AEAD_AES_256_GCM.to_string(),
        nonce: b64(&nonce),
        ciphertext: String::new(),
        checksum: String::new(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    let mut plaintext = Vec::with_capacity(TRANSFER_PLAINTEXT_LEN);
    plaintext.extend_from_slice(req.key.seed());
    plaintext.extend_from_slice(receipt_secret.as_bytes());
    let pass_key = derive_key(passphrase, &salt, &bundle.kdf_parameters)?;
    let ct = aes_seal(&pass_key, &nonce, &bundle.aad(), &plaintext)?;
    plaintext.zeroize();
    bundle.ciphertext = b64(&ct);
    bundle.checksum = bundle.compute_checksum();

    let now = chrono::Utc::now().to_rfc3339();
    req.conn
        .execute(
            "INSERT INTO authority_transfers
               (transfer_id, tenant_id, branch_id, source_authority_id, target_authority_id,
                source_install_id, target_install_id, root_key_id, root_generation,
                target_certificate, target_certificate_hash, commit_secret_hash,
                abort_secret_hash, sealed_commit_secret, sealed_commit_nonce,
                sealed_abort_secret, sealed_abort_nonce, sealed_receipt_secret,
                sealed_receipt_nonce, state, created_at, created_by)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,
                     'issued_pending',?20,?21)",
            params![
                rec.transfer_id,
                rec.tenant_id,
                rec.branch_id,
                rec.source_authority_id,
                rec.target_authority_id,
                rec.source_install_id,
                rec.target_install_id,
                rec.root_key_id,
                rec.root_generation,
                rec.target_certificate,
                rec.target_certificate_hash,
                rec.commit_secret_hash,
                rec.abort_secret_hash,
                sealed_commit,
                commit_nonce,
                sealed_abort,
                abort_nonce,
                sealed_receipt,
                receipt_nonce,
                now,
                req.owner.user_id(),
            ],
        )
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                ERR_TRANSFER_IN_FLIGHT
            } else {
                ERR_TRANSFER_INVALID
            }
        })?;

    Ok((bundle, rec))
}

// ── §8 T2 — import, on the target ───────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportOutcome {
    Imported,
    /// Byte-identical re-import of a transfer we already hold (§11).
    AlreadyImported,
}

/// T2 — the target decrypts the package, verifies it, and stores the root as PENDING.
///
/// Note what this does NOT do: it does not set `mode = primary`, does not write
/// `server_instance_id`, does not start a server, and does not make the root loadable by
/// the normal path. A package arriving is not the same as a machine becoming the host.
pub fn import(
    conn: &Connection,
    app_data_dir: &std::path::Path,
    raw: &str,
    install_id: &str,
    passphrase: &str,
) -> Result<ImportOutcome, &'static str> {
    let b = TransferBundle::from_json(raw)?;

    // Cheap identity checks before the 64 MiB KDF.
    if b.checksum != b.compute_checksum() {
        return Err(ERR_TRANSFER_INVALID);
    }
    // §14 T2/T6 — the package names one machine. This one, or nothing.
    if b.target_install_id != install_id {
        return Err(ERR_TRANSFER_WRONG_TARGET);
    }

    // Idempotence (§11): the same package twice is a no-op, a different one under the same
    // id is a contradiction we refuse rather than resolve.
    if let Ok(existing) = load_transfer(conn, &b.transfer_id) {
        if existing.target_certificate_hash != b.target_certificate_hash
            || existing.target_install_id != b.target_install_id
            || existing.commit_secret_hash != b.commit_secret_hash
        {
            return Err(ERR_TRANSFER_CONFLICT);
        }
        if matches!(
            existing.state,
            TransferState::TargetImported | TransferState::TargetConfirmed | TransferState::TargetActivated
        ) {
            return Ok(ImportOutcome::AlreadyImported);
        }
        if existing.state == TransferState::Aborted {
            return Err(ERR_TRANSFER_STATE);
        }
    }

    // Now the expensive part.
    let key = derive_key(passphrase, &unb64(&b.salt)?, &b.kdf_parameters)?;
    let mut pt = aes_open(&key, &unb64(&b.nonce)?, &b.aad(), &unb64(&b.ciphertext)?)?;
    if pt.len() != TRANSFER_PLAINTEXT_LEN {
        pt.zeroize();
        return Err(ERR_TRANSFER_INVALID);
    }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&pt[..32]);
    let receipt_secret = Secret32::from_slice(&pt[32..])?;
    pt.zeroize();

    // The decrypted seed must match the public record the package claims. If it does not,
    // the package is internally inconsistent and we must not store a key under a
    // root_key_id it does not belong to.
    let probe = trust_root::RootKey::from_seed(seed, b.root_key_id.clone());
    if probe.public_key_b64().is_empty() {
        seed.zeroize();
        return Err(ERR_TRANSFER_INVALID);
    }

    // The certificate must verify against the root that is IN this package, name this
    // install, and match the hash the AAD bound.
    let cert = AuthorityCertificate::from_json(&b.target_authority_certificate)?;
    if cert.payload.payload_hash() != b.target_certificate_hash {
        seed.zeroize();
        return Err(ERR_TRANSFER_INVALID);
    }
    let claimed_root = TrustRootRecord {
        tenant_id: b.tenant_id.clone(),
        root_key_id: b.root_key_id.clone(),
        public_key: probe.public_key_b64(),
        fingerprint: probe.fingerprint(),
        generation: b.root_generation,
        state: trust_root::RootState::Active,
    };
    let vctx = authority::VerifyContext {
        tenant_id: &b.tenant_id,
        branch_id: &b.branch_id,
        root: &claimed_root,
        expect_instance: Some(install_id),
    };
    if let Err(e) = authority::verify_certificate(&cert, &vctx) {
        seed.zeroize();
        return Err(e);
    }
    if cert.payload.authority_id != b.target_authority_id {
        seed.zeroize();
        return Err(ERR_TRANSFER_INVALID);
    }

    // If this DB already knows the tenant's root, the package must be about THAT root.
    if let Ok(Some(known)) = trust_root::load_active_root(conn, &b.tenant_id) {
        if known.root_key_id != b.root_key_id || known.public_key != claimed_root.public_key {
            seed.zeroize();
            return Err(ERR_TRANSFER_WRONG_TENANT);
        }
    }

    // Durable BEFORE any DB row says we hold it (§11): a row claiming target_imported with
    // no key file on disk is a transfer that can be confirmed and committed and then cannot
    // be activated — the source would already be retired.
    if let Err(e) = trust_root::write_pending_key(app_data_dir, &b.transfer_id, &seed) {
        seed.zeroize();
        return Err(e);
    }

    // The target seals the receipt secret under the pending seed, so a crash between here
    // and T3 does not lose the only thing that lets it confirm.
    let rec = TransferRecord {
        transfer_id: b.transfer_id.clone(),
        tenant_id: b.tenant_id.clone(),
        branch_id: b.branch_id.clone(),
        source_authority_id: b.source_authority_id.clone(),
        target_authority_id: b.target_authority_id.clone(),
        source_install_id: b.source_install_id.clone(),
        target_install_id: b.target_install_id.clone(),
        root_key_id: b.root_key_id.clone(),
        root_generation: b.root_generation,
        target_certificate: b.target_authority_certificate.clone(),
        target_certificate_hash: b.target_certificate_hash.clone(),
        commit_secret_hash: b.commit_secret_hash.clone(),
        abort_secret_hash: b.abort_secret_hash.clone(),
        state: TransferState::TargetImported,
        confirmation_level: None,
    };
    let sealed = seal_secret(&seed, &rec, PURPOSE_RECEIPT, &receipt_secret);
    seed.zeroize();
    let (sealed_receipt, receipt_nonce) = match sealed {
        Ok(v) => v,
        Err(e) => {
            trust_root::discard_pending_key(app_data_dir, &b.transfer_id);
            return Err(e);
        }
    };

    let now = chrono::Utc::now().to_rfc3339();
    let write = (|| -> Result<(), &'static str> {
        let tx = conn.unchecked_transaction().map_err(|_| ERR_TRANSFER_INVALID)?;
        tx.execute(
            "INSERT OR REPLACE INTO authority_transfers
               (transfer_id, tenant_id, branch_id, source_authority_id, target_authority_id,
                source_install_id, target_install_id, root_key_id, root_generation,
                target_certificate, target_certificate_hash, commit_secret_hash,
                abort_secret_hash, sealed_receipt_secret, sealed_receipt_nonce,
                state, created_at, imported_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'target_imported',?16,?16)",
            params![
                rec.transfer_id, rec.tenant_id, rec.branch_id, rec.source_authority_id,
                rec.target_authority_id, rec.source_install_id, rec.target_install_id,
                rec.root_key_id, rec.root_generation, rec.target_certificate,
                rec.target_certificate_hash, rec.commit_secret_hash, rec.abort_secret_hash,
                sealed_receipt, receipt_nonce, now,
            ],
        )
        .map_err(|_| ERR_TRANSFER_INVALID)?;
        tx.execute(
            "INSERT OR REPLACE INTO root_custody
               (tenant_id, root_key_id, root_generation, install_id, transfer_id, state, created_at)
             VALUES (?1,?2,?3,?4,?5,'target_pending',?6)",
            params![
                rec.tenant_id, rec.root_key_id, rec.root_generation, install_id,
                rec.transfer_id, now,
            ],
        )
        .map_err(|_| ERR_TRANSFER_INVALID)?;
        tx.commit().map_err(|_| ERR_TRANSFER_INVALID)
    })();

    if let Err(e) = write {
        // The key file is orphaned but harmless: nothing loads a pending key, and a retry
        // finds it identical and proceeds.
        return Err(e);
    }
    Ok(ImportOutcome::Imported)
}

// ── §8 T3 — the receipt, on the target ──────────────────────────────────────

/// T3 — prove the import. Re-runnable at will (§11): it re-derives the MAC from the sealed
/// receipt secret, so it never depends on state that only existed in the crashed process.
pub fn create_receipt(
    conn: &Connection,
    app_data_dir: &std::path::Path,
    transfer_id: &str,
    install_id: &str,
) -> Result<TargetReceipt, &'static str> {
    let rec = load_transfer(conn, transfer_id)?;
    if rec.target_install_id != install_id {
        return Err(ERR_TRANSFER_WRONG_TARGET);
    }
    if !matches!(
        rec.state,
        TransferState::TargetImported | TransferState::TargetConfirmed | TransferState::TargetActivated
    ) {
        return Err(ERR_TRANSFER_STATE);
    }

    let (sealed, nonce): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT sealed_receipt_secret, sealed_receipt_nonce FROM authority_transfers
              WHERE transfer_id = ?1",
            params![transfer_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| ERR_TRANSFER_INVALID)?;
    let (sealed, nonce) = (sealed.ok_or(ERR_TRANSFER_STATE)?, nonce.ok_or(ERR_TRANSFER_STATE)?);

    // The seed still lives under the pending name unless the transfer is already activated.
    let seed = match trust_root::load_pending_seed(app_data_dir, transfer_id) {
        Ok(s) => s,
        Err(_) if rec.state == TransferState::TargetActivated => {
            let root = trust_root::load_active_root(conn, &rec.tenant_id)
                .map_err(|_| ERR_TRANSFER_INVALID)?
                .ok_or(ERR_TRANSFER_INVALID)?;
            *trust_root::load_key(app_data_dir, &root)?.seed()
        }
        Err(e) => return Err(e),
    };

    let secret = open_secret(&seed, &rec, PURPOSE_RECEIPT, &sealed, &nonce)?;
    let imported_at: String = conn
        .query_row(
            "SELECT imported_at FROM authority_transfers WHERE transfer_id = ?1",
            params![transfer_id],
            |r| r.get(0),
        )
        .map_err(|_| ERR_TRANSFER_INVALID)?;

    let mut receipt = TargetReceipt {
        format_version: TRANSFER_FORMAT_VERSION,
        purpose: PURPOSE_RECEIPT.to_string(),
        transfer_id: rec.transfer_id.clone(),
        target_install_id: rec.target_install_id.clone(),
        target_authority_id: rec.target_authority_id.clone(),
        root_key_id: rec.root_key_id.clone(),
        root_generation: rec.root_generation,
        target_certificate_hash: rec.target_certificate_hash.clone(),
        imported_at,
        confirmation_level: CONFIRMATION_LEVEL.to_string(),
        mac: String::new(),
    };
    receipt.mac = receipt.compute_mac(&secret)?;

    // The target records its own view. The source's confirmation (T4) is separate and does
    // not depend on this row existing.
    if rec.state == TransferState::TargetImported {
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE authority_transfers
                SET state = 'target_confirmed', confirmed_at = ?2, confirmation_level = ?3
              WHERE transfer_id = ?1 AND state = 'target_imported'",
            params![transfer_id, now, CONFIRMATION_LEVEL],
        )
        .map_err(|_| ERR_TRANSFER_INVALID)?;
    }
    Ok(receipt)
}

// ── §8 T4 — confirmation, on the source ─────────────────────────────────────

/// T4 — the source verifies the receipt. No commit without this.
pub fn confirm_receipt(
    conn: &Connection,
    app_data_dir: &std::path::Path,
    raw: &str,
    install_id: &str,
    root: &TrustRootRecord,
) -> Result<(), &'static str> {
    let receipt = TargetReceipt::from_json(raw)?;
    let rec = load_transfer(conn, &receipt.transfer_id)?;

    if rec.source_install_id != install_id {
        return Err(ERR_TRANSFER_WRONG_TARGET);
    }
    // Idempotent (§11): confirming twice is the same fact stated twice.
    if matches!(rec.state, TransferState::TargetConfirmed | TransferState::Committed) {
        return Ok(());
    }
    if rec.state != TransferState::IssuedPending && rec.state != TransferState::TargetImported {
        return Err(ERR_TRANSFER_STATE);
    }

    // Every field must match the transfer we issued — the MAC proves the secret, these
    // prove it is a receipt about THIS handover and not a replay from another one.
    if receipt.target_install_id != rec.target_install_id
        || receipt.target_authority_id != rec.target_authority_id
        || receipt.root_key_id != rec.root_key_id
        || receipt.root_generation != rec.root_generation
        || receipt.target_certificate_hash != rec.target_certificate_hash
    {
        return Err(ERR_RECEIPT_INVALID);
    }
    if receipt.confirmation_level != CONFIRMATION_LEVEL {
        return Err(ERR_RECEIPT_INVALID);
    }

    // The source unseals its own copy of the receipt secret and checks the MAC.
    let key = trust_root::load_key(app_data_dir, root)?;
    let (sealed, nonce) = sealed_pair(conn, &rec.transfer_id, "receipt")?;
    let secret = open_secret(key.seed(), &rec, PURPOSE_RECEIPT, &sealed, &nonce)?;
    receipt.verify_mac(&secret)?;

    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE authority_transfers
            SET state = 'target_confirmed', confirmed_at = ?2, confirmation_level = ?3
          WHERE transfer_id = ?1 AND state IN ('issued_pending','target_imported')",
        params![rec.transfer_id, now, CONFIRMATION_LEVEL],
    )
    .map_err(|_| ERR_TRANSFER_INVALID)?;
    Ok(())
}

/// Read one sealed (ciphertext, nonce) pair. `which` is `commit` / `abort` / `receipt`.
fn sealed_pair(
    conn: &Connection,
    transfer_id: &str,
    which: &str,
) -> Result<(String, String), &'static str> {
    // Column names cannot be bound as parameters, so they come from this match and never
    // from a caller's string — the only three values that can reach the SQL are these.
    let (c, n) = match which {
        "commit" => ("sealed_commit_secret", "sealed_commit_nonce"),
        "abort" => ("sealed_abort_secret", "sealed_abort_nonce"),
        "receipt" => ("sealed_receipt_secret", "sealed_receipt_nonce"),
        _ => return Err(ERR_TRANSFER_INVALID),
    };
    let (s, v): (Option<String>, Option<String>) = conn
        .query_row(
            &format!("SELECT {c}, {n} FROM authority_transfers WHERE transfer_id = ?1"),
            params![transfer_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| ERR_TRANSFER_INVALID)?;
    Ok((s.ok_or(ERR_TRANSFER_STATE)?, v.ok_or(ERR_TRANSFER_STATE)?))
}

// ── §8 T5 — commit, on the source. THE POINT OF NO RETURN ───────────────────

/// T5 — the source stops being the authority. One atomic transaction, or nothing.
///
/// After this returns, the source cannot sign: its custody is `source_retired` and §9's gate
/// refuses. The root key FILE stays on disk deliberately — deleting it would make an abort
/// impossible to recover from and would destroy the only copy if the target never activates.
/// The gate checks the DB, not the file's existence, which is exactly why "the file is
/// there" was never a sufficient condition to sign.
pub fn commit(
    conn: &Connection,
    transfer_id: &str,
    install_id: &str,
    owner: &OwnerAuth,
) -> Result<(), &'static str> {
    let rec = load_transfer(conn, transfer_id)?;
    if rec.source_install_id != install_id {
        return Err(ERR_TRANSFER_WRONG_TARGET);
    }
    // Idempotent (§11 "doppelter Commit"): already committed is success, not a second commit.
    if matches!(rec.state, TransferState::Committed | TransferState::TargetActivated) {
        return Ok(());
    }
    if rec.state == TransferState::Aborted {
        return Err(ERR_TRANSFER_STATE);
    }
    // §8 T4 — no commit without a verified receipt. This is the check that stops the source
    // from retiring itself into a void because the target never actually got the package.
    if rec.state != TransferState::TargetConfirmed {
        return Err(ERR_TRANSFER_NOT_CONFIRMED);
    }

    let now = chrono::Utc::now().to_rfc3339();
    let tx = conn.unchecked_transaction().map_err(|_| ERR_TRANSFER_INVALID)?;

    // The `state = 'target_confirmed'` predicate makes this a compare-and-set: a concurrent
    // commit or abort that got here first changes the state, this UPDATE matches 0 rows, and
    // we roll back rather than commit on top of someone else's decision.
    let n = tx
        .execute(
            "UPDATE authority_transfers
                SET state = 'committed', committed_at = ?2, committed_by = ?3
              WHERE transfer_id = ?1 AND state = 'target_confirmed'",
            params![transfer_id, now, owner.user_id()],
        )
        .map_err(|_| ERR_TRANSFER_INVALID)?;
    if n != 1 {
        return Err(ERR_TRANSFER_STATE);
    }
    tx.execute(
        "UPDATE authority_certificates SET status = 'superseded'
          WHERE authority_id = ?1 AND status = 'active'",
        params![rec.source_authority_id],
    )
    .map_err(|_| ERR_TRANSFER_INVALID)?;
    tx.execute(
        "UPDATE root_custody
            SET state = 'source_retired', retired_at = ?3
          WHERE tenant_id = ?1 AND install_id = ?2 AND state = 'source_active'",
        params![rec.tenant_id, install_id, now],
    )
    .map_err(|_| ERR_TRANSFER_INVALID)?;
    tx.commit().map_err(|_| ERR_TRANSFER_INVALID)?;
    Ok(())
}

// ── §8 T6 — the commit token ────────────────────────────────────────────────

/// T6 — hand out the commit secret. Only after T5, and re-exportable forever after (§11).
///
/// This is the narrow path §5 requires: it reaches the sealed commit secret even though the
/// normal signing custody is already retired. It can ONLY export a token — it never returns
/// a key, never signs, and never touches a certificate. That narrowness is the whole reason
/// it is allowed to exist past the retirement.
pub fn export_commit_token(
    conn: &Connection,
    app_data_dir: &std::path::Path,
    transfer_id: &str,
    install_id: &str,
) -> Result<TransferToken, &'static str> {
    let rec = load_transfer(conn, transfer_id)?;
    if rec.source_install_id != install_id {
        return Err(ERR_TRANSFER_WRONG_TARGET);
    }
    if !matches!(rec.state, TransferState::Committed | TransferState::TargetActivated) {
        return Err(ERR_TRANSFER_NOT_CONFIRMED);
    }

    // Deliberately NOT `require_signing_root`: that gate is about signing, and this machine
    // may no longer sign. Load the key file directly — this path's authority to do so comes
    // from the transfer record, not from custody.
    let root = trust_root::load_active_root(conn, &rec.tenant_id)
        .map_err(|_| ERR_TRANSFER_INVALID)?
        .ok_or(ERR_TRANSFER_INVALID)?;
    let key = trust_root::load_key(app_data_dir, &root)?;
    let (sealed, nonce) = sealed_pair(conn, transfer_id, "commit")?;
    let secret = open_secret(key.seed(), &rec, PURPOSE_COMMIT, &sealed, &nonce)?;

    let committed_at: String = conn
        .query_row(
            "SELECT committed_at FROM authority_transfers WHERE transfer_id = ?1",
            params![transfer_id],
            |r| r.get(0),
        )
        .map_err(|_| ERR_TRANSFER_INVALID)?;

    Ok(TransferToken {
        format_version: TRANSFER_FORMAT_VERSION,
        purpose: PURPOSE_COMMIT.to_string(),
        transfer_id: rec.transfer_id.clone(),
        secret: secret.to_b64(),
        issued_at: committed_at,
        target_certificate_hash: rec.target_certificate_hash.clone(),
    })
}

// ── §8 T7 — activation, on the target ───────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivateOutcome {
    Activated,
    /// Already active — a retried activation (§11).
    AlreadyActive,
}

/// T7 — the target becomes the authority.
///
/// Order (§8): verify the token, publish the key file, THEN commit the DB. The file first is
/// not an accident — see `publish_pending_as_active` for why the other order is unsafe.
///
/// This does NOT make the target a B2A primary. The role and the custody are different
/// questions, and a transfer that silently granted the primary role would re-introduce
/// exactly the implicit promotion M6-B2A removed.
pub fn activate(
    conn: &Connection,
    app_data_dir: &std::path::Path,
    raw_token: &str,
    install_id: &str,
) -> Result<ActivateOutcome, &'static str> {
    let token = TransferToken::from_json(raw_token, PURPOSE_COMMIT)?;
    let rec = load_transfer(conn, &token.transfer_id)?;

    if rec.target_install_id != install_id {
        return Err(ERR_TRANSFER_WRONG_TARGET);
    }
    if rec.state == TransferState::TargetActivated {
        return Ok(ActivateOutcome::AlreadyActive);
    }
    if rec.state == TransferState::Aborted {
        return Err(ERR_TRANSFER_STATE);
    }
    if !matches!(rec.state, TransferState::TargetImported | TransferState::TargetConfirmed) {
        return Err(ERR_TRANSFER_STATE);
    }
    if token.target_certificate_hash != rec.target_certificate_hash {
        return Err(ERR_TOKEN_INVALID);
    }

    // §14 T23 — the commitment from the ORIGINAL package is what the token must open. An
    // abort token hashes under a different domain, so it can never satisfy this.
    let secret = Secret32::from_b64(&token.secret).map_err(|_| ERR_TOKEN_INVALID)?;
    let expect = commitment(
        canonical::DOMAIN_TRANSFER_COMMIT,
        &rec.transfer_id,
        &rec.target_install_id,
        &rec.target_authority_id,
        &rec.target_certificate_hash,
        &secret,
    );
    if expect != rec.commit_secret_hash {
        return Err(ERR_TOKEN_INVALID);
    }

    // The pending key must still be the root the certificate belongs to.
    let seed = trust_root::load_pending_seed(app_data_dir, &rec.transfer_id)?;
    let probe = trust_root::RootKey::from_seed(seed, rec.root_key_id.clone());
    let cert = AuthorityCertificate::from_json(&rec.target_certificate)?;
    if cert.payload.payload_hash() != rec.target_certificate_hash {
        return Err(ERR_TRANSFER_INVALID);
    }
    let root = TrustRootRecord {
        tenant_id: rec.tenant_id.clone(),
        root_key_id: rec.root_key_id.clone(),
        public_key: probe.public_key_b64(),
        fingerprint: probe.fingerprint(),
        generation: rec.root_generation,
        state: trust_root::RootState::Active,
    };
    let vctx = authority::VerifyContext {
        tenant_id: &rec.tenant_id,
        branch_id: &rec.branch_id,
        root: &root,
        expect_instance: Some(install_id),
    };
    authority::verify_certificate(&cert, &vctx)?;

    // Do we already hold this exact certificate, and in what state? A serial we know as
    // superseded or revoked must never come back as active — that is a returning claim, not
    // an activation, however valid its signature.
    match authority::known_certificate_status(conn, &cert.payload.certificate_serial)? {
        None => {}
        Some(authority::CertStatus::Active) => return Ok(ActivateOutcome::AlreadyActive),
        Some(authority::CertStatus::Revoked) => return Err(authority::ERR_REVOKED),
        Some(_) => return Err(authority::ERR_EPOCH_ROLLBACK),
    }

    // The certificate is valid — but is it CURRENT? A valid certificate can still be stale:
    // if this target already holds a higher epoch (it was the authority before, or a later
    // transfer already landed), activating this one would roll the authority backwards.
    // Single-sourced with the classifier that reports claims, so "the report says rollback
    // but the activator took it anyway" cannot happen.
    match authority::classify_claim(conn, &cert, &vctx)? {
        authority::ClaimVerdict::Current => {}
        authority::ClaimVerdict::Revoked => return Err(authority::ERR_REVOKED),
        authority::ClaimVerdict::Rollback => return Err(authority::ERR_EPOCH_ROLLBACK),
        // Equal epoch, different authority: two claims of the same rank. Detected, never
        // decided — nothing here can know which side the rest of the shop talked to.
        authority::ClaimVerdict::PartitionUnresolved => {
            return Err(authority::ERR_PARTITION_UNRESOLVED)
        }
    }

    // FILE FIRST. A crash after this and before the DB commit leaves an active key file that
    // nothing will load, because custody is still target_pending — and the retry below finds
    // it identical and finishes the job.
    let published = trust_root::publish_pending_as_active(app_data_dir, &rec.transfer_id, &seed)?;

    let now = chrono::Utc::now().to_rfc3339();
    let tx = conn.unchecked_transaction().map_err(|_| ERR_TRANSFER_INVALID)?;
    // The root record may not exist here at all: a fresh target has no tenant_trust_roots
    // row. Insert it, or verify the existing one agrees.
    match trust_root::load_active_root(&tx, &rec.tenant_id).map_err(|_| ERR_TRANSFER_INVALID)? {
        Some(known) => {
            if known.root_key_id != root.root_key_id || known.public_key != root.public_key {
                return Err(ERR_TRANSFER_WRONG_TENANT);
            }
        }
        None => {
            tx.execute(
                "INSERT INTO tenant_trust_roots
                   (tenant_id, root_key_id, public_key, fingerprint, generation, state,
                    created_at, activated_at, created_by)
                 VALUES (?1,?2,?3,?4,?5,'active',?6,?6,NULL)",
                params![
                    root.tenant_id, root.root_key_id, root.public_key, root.fingerprint,
                    root.generation, now,
                ],
            )
            .map_err(|_| ERR_TRANSFER_INVALID)?;
        }
    }
    tx.execute(
        "UPDATE root_custody
            SET state = 'target_active', activated_at = ?3
          WHERE tenant_id = ?1 AND install_id = ?2 AND state = 'target_pending'",
        params![rec.tenant_id, install_id, now],
    )
    .map_err(|_| ERR_TRANSFER_INVALID)?;
    // The certificate becomes active HERE and nowhere earlier — §8 T1's "not as an active
    // authority until activation" is enforced by this being the only insert of it.
    authority::insert_certificate_active(&tx, &cert)?;
    tx.execute(
        "UPDATE authority_transfers
            SET state = 'target_activated', activated_at = ?2
          WHERE transfer_id = ?1",
        params![rec.transfer_id, now],
    )
    .map_err(|_| ERR_TRANSFER_INVALID)?;
    tx.commit().map_err(|_| ERR_TRANSFER_INVALID)?;

    trust_root::discard_pending_key(app_data_dir, &rec.transfer_id);
    Ok(match published {
        trust_root::PublishOutcome::Published => ActivateOutcome::Activated,
        trust_root::PublishOutcome::AlreadyIdentical => ActivateOutcome::Activated,
    })
}

// ── §10 — abort ─────────────────────────────────────────────────────────────

/// Abort on the source. Only before the commit; the source keeps everything.
pub fn abort(
    conn: &Connection,
    app_data_dir: &std::path::Path,
    transfer_id: &str,
    install_id: &str,
    root: &TrustRootRecord,
) -> Result<TransferToken, &'static str> {
    let rec = load_transfer(conn, transfer_id)?;
    if rec.source_install_id != install_id {
        return Err(ERR_TRANSFER_WRONG_TARGET);
    }
    // §10/§14 T22 — after the commit the source has already stopped. "Undoing" it could
    // re-activate a custody the target has meanwhile taken over: two live authorities, the
    // exact thing the two-phase order exists to prevent.
    if matches!(rec.state, TransferState::Committed | TransferState::TargetActivated) {
        return Err(ERR_TRANSFER_ALREADY_COMMITTED);
    }
    if !rec.state.may_abort() && rec.state != TransferState::Aborted {
        return Err(ERR_TRANSFER_STATE);
    }

    let key = trust_root::load_key(app_data_dir, root)?;
    let (sealed, nonce) = sealed_pair(conn, transfer_id, "abort")?;
    let secret = open_secret(key.seed(), &rec, PURPOSE_ABORT, &sealed, &nonce)?;

    let now = chrono::Utc::now().to_rfc3339();
    if rec.state != TransferState::Aborted {
        // CAS again: `may_abort` states only. A commit that landed between the check above
        // and here matches 0 rows and we refuse.
        let n = conn
            .execute(
                "UPDATE authority_transfers
                    SET state = 'aborted', aborted_at = ?2
                  WHERE transfer_id = ?1
                    AND state IN ('issued_pending','target_imported','target_confirmed')",
                params![transfer_id, now],
            )
            .map_err(|_| ERR_TRANSFER_INVALID)?;
        if n != 1 {
            return Err(ERR_TRANSFER_ALREADY_COMMITTED);
        }
    }

    let aborted_at: String = conn
        .query_row(
            "SELECT aborted_at FROM authority_transfers WHERE transfer_id = ?1",
            params![transfer_id],
            |r| r.get(0),
        )
        .map_err(|_| ERR_TRANSFER_INVALID)?;

    Ok(TransferToken {
        format_version: TRANSFER_FORMAT_VERSION,
        purpose: PURPOSE_ABORT.to_string(),
        transfer_id: rec.transfer_id.clone(),
        secret: secret.to_b64(),
        issued_at: aborted_at,
        target_certificate_hash: rec.target_certificate_hash.clone(),
    })
}

/// The target stands down. Its pending key goes; the active root NEVER does.
pub fn import_abort(
    conn: &Connection,
    app_data_dir: &std::path::Path,
    raw_token: &str,
    install_id: &str,
) -> Result<(), &'static str> {
    let token = TransferToken::from_json(raw_token, PURPOSE_ABORT)?;
    let rec = load_transfer(conn, &token.transfer_id)?;

    if rec.target_install_id != install_id {
        return Err(ERR_TRANSFER_WRONG_TARGET);
    }
    if rec.state == TransferState::Aborted {
        return Ok(());
    }
    if matches!(rec.state, TransferState::Committed | TransferState::TargetActivated) {
        return Err(ERR_TRANSFER_ALREADY_COMMITTED);
    }
    if token.target_certificate_hash != rec.target_certificate_hash {
        return Err(ERR_TOKEN_INVALID);
    }

    // The ABORT commitment, under its own domain. A commit token cannot open this.
    let secret = Secret32::from_b64(&token.secret).map_err(|_| ERR_TOKEN_INVALID)?;
    let expect = commitment(
        canonical::DOMAIN_TRANSFER_ABORT,
        &rec.transfer_id,
        &rec.target_install_id,
        &rec.target_authority_id,
        &rec.target_certificate_hash,
        &secret,
    );
    if expect != rec.abort_secret_hash {
        return Err(ERR_TOKEN_INVALID);
    }

    let now = chrono::Utc::now().to_rfc3339();
    let tx = conn.unchecked_transaction().map_err(|_| ERR_TRANSFER_INVALID)?;
    tx.execute(
        "UPDATE authority_transfers SET state = 'aborted', aborted_at = ?2
          WHERE transfer_id = ?1",
        params![rec.transfer_id, now],
    )
    .map_err(|_| ERR_TRANSFER_INVALID)?;
    tx.execute(
        "UPDATE root_custody SET state = 'aborted', aborted_at = ?3
          WHERE tenant_id = ?1 AND install_id = ?2 AND state = 'target_pending'",
        params![rec.tenant_id, install_id, now],
    )
    .map_err(|_| ERR_TRANSFER_INVALID)?;
    tx.commit().map_err(|_| ERR_TRANSFER_INVALID)?;

    // Best-effort, and only ever the pending name. Never the active key: a failed transfer
    // must not be able to delete the root a tenant is actually using.
    trust_root::discard_pending_key(app_data_dir, &rec.transfer_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::primary::{self, State};
    use crate::sync::trust_root::testkit::*;

    const ID_SOURCE: &str = "11111111-1111-4111-8111-111111111111";
    const ID_TARGET: &str = "22222222-2222-4222-8222-222222222222";
    const ID_OTHER: &str = "33333333-3333-4333-8333-333333333333";
    const PW: &str = "correct horse battery staple";

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
        lataif_server::migrations::run_migrations(&conn, crate::sync::migrations::EMBEDDED_MIGRATIONS)
            .unwrap();
        conn
    }

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
        conn.execute_batch(
            "INSERT INTO server_credentials
               (user_id, credential_state, password_changed_at, created_at, updated_at)
             VALUES ('user-owner','active','n','n','n');",
        )
        .unwrap();
        primary::authorize_owner(conn, "tenant-1", "branch-main", "owner@x.com", "owner-pw").unwrap()
    }

    /// One machine: its own DB, its own app data dir, its own install id.
    ///
    /// Field order is the cleanup mechanism, not a style choice: `conn` is declared before
    /// `dir`, fields drop in declaration order, so the connection closes before the
    /// directory is removed. A `Drop` impl on this struct would run BEFORE its fields drop —
    /// with the DB still open — and on Windows the removal would then fail silently.
    struct Host {
        conn: Connection,
        dir: TempDir,
        install: &'static str,
        owner: primary::OwnerAuth,
    }

    /// A machine that founded the tenant root and holds authority epoch 1.
    fn source() -> Host {
        let conn = db();
        let o = owner(&conn);
        let dir = tmp_dir();
        trust_root::initialize_root(&conn, &dir, "tenant-1", ID_SOURCE, State::Primary, &o).unwrap();
        let root = trust_root::load_active_root(&conn, "tenant-1").unwrap().unwrap();
        let key = trust_root::load_key(&dir, &root).unwrap();
        let cert = authority::initialize_authority(&authority::IssueContext {
            conn: &conn,
            tenant_id: "tenant-1",
            branch_id: "branch-main",
            install_id: ID_SOURCE,
            primary_state: State::Primary,
            root: &root,
            key: &key,
            owner: &o,
        })
        .unwrap();
        assert_eq!(cert.payload.authority_epoch, 1);
        drop(key);
        Host { conn, dir, install: ID_SOURCE, owner: o }
    }

    /// A fresh machine: no root, no authority, no custody. What a real target looks like.
    fn target() -> Host {
        let conn = db();
        let o = owner(&conn);
        let dir = tmp_dir();
        Host { conn, dir, install: ID_TARGET, owner: o }
    }

    impl Host {
        fn root(&self) -> TrustRootRecord {
            trust_root::load_active_root(&self.conn, "tenant-1").unwrap().unwrap()
        }
        fn key(&self) -> RootKey {
            trust_root::load_key(&self.dir, &self.root()).unwrap()
        }
        fn custody(&self) -> Option<CustodyState> {
            custody_state(&self.conn, "tenant-1", self.install).unwrap()
        }
        fn cert_status(&self, authority_id: &str) -> String {
            self.conn
                .query_row(
                    "SELECT status FROM authority_certificates WHERE authority_id = ?1",
                    params![authority_id],
                    |r| r.get(0),
                )
                .unwrap()
        }
        fn active_authority_id(&self) -> Option<String> {
            authority::load_active(&self.conn, "tenant-1", "branch-main")
                .unwrap()
                .map(|c| c.authority_id)
        }
    }

    /// T1 against a real source.
    fn issue_from(src: &Host, target_install: &str) -> (TransferBundle, TransferRecord) {
        let root = src.root();
        let key = src.key();
        let req = IssueRequest {
            conn: &src.conn,
            tenant_id: "tenant-1",
            branch_id: "branch-main",
            install_id: src.install,
            primary_state: State::Primary,
            root: &root,
            key: &key,
            owner: &src.owner,
        };
        issue(&req, target_install, PW, PW, TRANSFER_CONFIRMATION).unwrap()
    }

    /// Drive T1…T5. Returns (package, record, receipt).
    fn upto_commit(src: &Host, tgt: &Host) -> (TransferBundle, TransferRecord, TargetReceipt) {
        let (b, rec) = issue_from(src, tgt.install);
        let raw = b.to_json().unwrap();
        import(&tgt.conn, &tgt.dir, &raw, tgt.install, PW).unwrap();
        let receipt = create_receipt(&tgt.conn, &tgt.dir, &rec.transfer_id, tgt.install).unwrap();
        confirm_receipt(
            &src.conn,
            &src.dir,
            &receipt.to_json().unwrap(),
            src.install,
            &src.root(),
        )
        .unwrap();
        commit(&src.conn, &rec.transfer_id, src.install, &src.owner).unwrap();
        (b, rec, receipt)
    }

    // ── T1: the root travels only encrypted ──────────────────────────────────
    #[test]
    fn t1_root_is_only_in_the_package_encrypted() {
        use base64::Engine;
        let src = source();
        let (b, _rec) = issue_from(&src, ID_TARGET);
        let raw = b.to_json().unwrap();

        let seed = *src.key().seed();
        let seed_b64 = base64::engine::general_purpose::STANDARD.encode(seed);
        let seed_hex: String = seed.iter().map(|x| format!("{x:02x}")).collect();

        assert!(!raw.contains(&seed_b64), "the seed must not appear base64-encoded");
        assert!(!raw.contains(&seed_hex), "the seed must not appear hex-encoded");
        assert!(
            !raw.as_bytes().windows(32).any(|w| w == seed),
            "the raw seed bytes must not appear anywhere in the package"
        );
        assert!(!raw.contains(PW), "the passphrase must never be written");
        // §4 — the two secrets that must NOT travel.
        assert!(!raw.contains("\"commit_secret\""), "no commit secret field");
        assert!(!raw.contains("\"abort_secret\""), "no abort secret field");
        assert_eq!(b.commit_secret_hash.len(), 64, "only the commitment travels");
        assert_ne!(b.commit_secret_hash, b.abort_secret_hash, "different secrets");
    }

    // ── T2: the package is bound to one target ───────────────────────────────
    #[test]
    fn t2_transfer_is_bound_to_the_target_install_id() {
        let src = source();
        let (mut b, _rec) = issue_from(&src, ID_TARGET);

        // Rewriting the target does not produce a package that opens elsewhere — it
        // produces one that does not open at all, because the id is in the AEAD's AAD.
        b.target_install_id = ID_OTHER.to_string();
        b.checksum = b.compute_checksum();
        let tgt = target();
        assert_eq!(
            import(&tgt.conn, &tgt.dir, &b.to_json().unwrap(), ID_OTHER, PW).unwrap_err(),
            ERR_TRANSFER_INVALID,
            "AAD binds the target: the edit breaks decryption, not just a comparison"
        );
    }

    // ── T3: recovery and transfer are not interchangeable ────────────────────
    #[test]
    fn t3_recovery_and_transfer_purposes_are_separate() {
        let src = source();
        let (mut b, _rec) = issue_from(&src, ID_TARGET);
        let tgt = target();

        // A transfer package fed to the recovery importer.
        assert!(
            crate::sync::recovery::import_bundle(&b.to_json().unwrap(), "tenant-1", PW).is_err(),
            "a transfer package is not a recovery bundle"
        );
        // …and a package claiming to be a recovery bundle fed to the transfer importer.
        b.purpose = PURPOSE_RECOVERY.to_string();
        b.checksum = b.compute_checksum();
        assert_eq!(
            import(&tgt.conn, &tgt.dir, &b.to_json().unwrap(), ID_TARGET, PW).unwrap_err(),
            ERR_TRANSFER_WRONG_PURPOSE,
            "the sibling purpose is recognised by name and refused"
        );
        // The two AADs cannot collide: different domain separators.
        assert_ne!(
            crate::sync::canonical::DOMAIN_TRANSFER_BUNDLE_AAD,
            crate::sync::canonical::DOMAIN_RECOVERY_BUNDLE_AAD
        );
    }

    // ── T4/T9: the source stays the authority until IT commits ───────────────
    #[test]
    fn t4_t9_source_stays_active_until_commit() {
        let src = source();
        let before = src.active_authority_id().unwrap();
        let (b, rec) = issue_from(&src, ID_TARGET);

        // After T1 — nothing moved.
        assert_eq!(src.custody(), Some(CustodyState::SourceActive), "T4: still active");
        assert_eq!(src.cert_status(&before), "active", "T9: not superseded at issue time");
        assert_eq!(src.active_authority_id().as_deref(), Some(before.as_str()));
        assert_eq!(
            load_transfer(&src.conn, &rec.transfer_id).unwrap().state,
            TransferState::IssuedPending
        );
        // The target's certificate is NOT recorded anywhere as an authority yet.
        let n: i64 = src
            .conn
            .query_row(
                "SELECT COUNT(*) FROM authority_certificates WHERE authority_id = ?1",
                params![rec.target_authority_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            n, 0,
            "T1: the target certificate lives in the transfer record, not as an authority"
        );

        // After T2/T3/T4 — still nothing moved.
        let tgt = target();
        import(&tgt.conn, &tgt.dir, &b.to_json().unwrap(), ID_TARGET, PW).unwrap();
        let receipt = create_receipt(&tgt.conn, &tgt.dir, &rec.transfer_id, ID_TARGET).unwrap();
        confirm_receipt(&src.conn, &src.dir, &receipt.to_json().unwrap(), src.install, &src.root())
            .unwrap();
        assert_eq!(src.custody(), Some(CustodyState::SourceActive), "T4: still active after receipt");
        assert_eq!(src.cert_status(&before), "active", "T9: still not superseded");

        // T5 — now it moves, and only now.
        commit(&src.conn, &rec.transfer_id, src.install, &src.owner).unwrap();
        assert_eq!(src.custody(), Some(CustodyState::SourceRetired));
        assert_eq!(src.cert_status(&before), "superseded", "T9: superseded at commit, not before");
    }

    // ── T5/T10: import yields target_imported and a PENDING root only ────────
    #[test]
    fn t5_t10_import_yields_pending_not_active() {
        let src = source();
        let (b, rec) = issue_from(&src, ID_TARGET);
        let tgt = target();
        assert_eq!(
            import(&tgt.conn, &tgt.dir, &b.to_json().unwrap(), ID_TARGET, PW).unwrap(),
            ImportOutcome::Imported
        );

        assert_eq!(
            load_transfer(&tgt.conn, &rec.transfer_id).unwrap().state,
            TransferState::TargetImported,
            "T5"
        );
        assert_eq!(tgt.custody(), Some(CustodyState::TargetPending), "T10");
        assert!(!tgt.custody().unwrap().may_sign(), "T10: pending must not sign");

        // §6 — the key is under the pending name; the ACTIVE name does not exist.
        assert!(trust_root::pending_key_exists(&tgt.dir, &rec.transfer_id));
        assert!(!trust_root::key_file_exists(&tgt.dir), "the normal loader must find nothing");
        // …and the normal root loader agrees: there is no signing root here.
        assert_eq!(
            trust_root::require_signing_root(&tgt.conn, &tgt.dir, "tenant-1").unwrap_err(),
            trust_root::ERR_ROOT_KEY_MISSING
        );
    }

    // ── T6: the wrong machine cannot import ──────────────────────────────────
    #[test]
    fn t6_wrong_target_is_refused() {
        let src = source();
        let (b, _rec) = issue_from(&src, ID_TARGET);
        let other = Host { install: ID_OTHER, ..target() };
        assert_eq!(
            import(&other.conn, &other.dir, &b.to_json().unwrap(), ID_OTHER, PW).unwrap_err(),
            ERR_TRANSFER_WRONG_TARGET
        );
        assert!(!trust_root::key_file_exists(&other.dir), "no key written for the wrong machine");
        assert_eq!(other.custody(), None);
    }

    // ── T7/T8: no commit without a valid receipt ─────────────────────────────
    #[test]
    fn t7_t8_commit_requires_a_valid_receipt() {
        let src = source();
        let (b, rec) = issue_from(&src, ID_TARGET);

        // T8 — straight to commit, no receipt.
        assert_eq!(
            commit(&src.conn, &rec.transfer_id, src.install, &src.owner).unwrap_err(),
            ERR_TRANSFER_NOT_CONFIRMED
        );
        assert_eq!(src.custody(), Some(CustodyState::SourceActive), "a refused commit changes nothing");

        // T7 — a receipt with a valid shape but a forged MAC.
        let tgt = target();
        import(&tgt.conn, &tgt.dir, &b.to_json().unwrap(), ID_TARGET, PW).unwrap();
        let mut receipt = create_receipt(&tgt.conn, &tgt.dir, &rec.transfer_id, ID_TARGET).unwrap();
        receipt.mac = b64(&[7u8; 32]);
        assert_eq!(
            confirm_receipt(&src.conn, &src.dir, &receipt.to_json().unwrap(), src.install, &src.root())
                .unwrap_err(),
            ERR_RECEIPT_INVALID,
            "T7: a forged MAC must not confirm"
        );
        assert_eq!(
            commit(&src.conn, &rec.transfer_id, src.install, &src.owner).unwrap_err(),
            ERR_TRANSFER_NOT_CONFIRMED
        );
    }

    // ── T11: the target becomes active only with the commit token ────────────
    #[test]
    fn t11_target_active_only_after_commit_token() {
        let src = source();
        let tgt = target();
        let (_b, rec, _r) = upto_commit(&src, &tgt);

        // Between T5 and T7: NOBODY can sign. That is the correct failure mode — the
        // alternative is an overlap, which is two live authorities.
        assert_eq!(src.custody(), Some(CustodyState::SourceRetired));
        assert_eq!(tgt.custody(), Some(CustodyState::TargetPending));
        assert!(!src.custody().unwrap().may_sign() && !tgt.custody().unwrap().may_sign());

        let token = export_commit_token(&src.conn, &src.dir, &rec.transfer_id, src.install).unwrap();
        assert_eq!(
            activate(&tgt.conn, &tgt.dir, &token.to_json().unwrap(), ID_TARGET).unwrap(),
            ActivateOutcome::Activated
        );
        assert_eq!(tgt.custody(), Some(CustodyState::TargetActive), "T11");
        assert!(trust_root::key_file_exists(&tgt.dir), "the root is now under the active name");
        assert_eq!(tgt.active_authority_id().as_deref(), Some(rec.target_authority_id.as_str()));
        assert_eq!(
            load_transfer(&tgt.conn, &rec.transfer_id).unwrap().state,
            TransferState::TargetActivated
        );
    }

    // ── T23: activation without a valid commit token is refused ──────────────
    #[test]
    fn t23_activation_without_a_valid_token_is_refused() {
        let src = source();
        let tgt = target();
        let (_b, rec, _r) = upto_commit(&src, &tgt);
        let good = export_commit_token(&src.conn, &src.dir, &rec.transfer_id, src.install).unwrap();

        // A token with a random secret: right shape, wrong commitment.
        let mut forged = good.clone();
        forged.secret = b64(&[9u8; 32]);
        assert_eq!(
            activate(&tgt.conn, &tgt.dir, &forged.to_json().unwrap(), ID_TARGET).unwrap_err(),
            ERR_TOKEN_INVALID
        );
        // A token for a different certificate hash.
        let mut wrong_hash = good.clone();
        wrong_hash.target_certificate_hash = "aa".repeat(32);
        assert_eq!(
            activate(&tgt.conn, &tgt.dir, &wrong_hash.to_json().unwrap(), ID_TARGET).unwrap_err(),
            ERR_TOKEN_INVALID
        );
        assert_eq!(tgt.custody(), Some(CustodyState::TargetPending), "still pending");
        assert!(!trust_root::key_file_exists(&tgt.dir), "no key published by a refused activation");
    }

    // ── an abort token cannot serve as a commit token ────────────────────────
    #[test]
    fn an_abort_token_can_never_commit() {
        let src = source();
        let tgt = target();
        let (b, rec) = issue_from(&src, ID_TARGET);
        import(&tgt.conn, &tgt.dir, &b.to_json().unwrap(), ID_TARGET, PW).unwrap();

        let abort_token =
            abort(&src.conn, &src.dir, &rec.transfer_id, src.install, &src.root()).unwrap();

        // Same transfer, same certificate hash, a real secret the source really issued —
        // and it still cannot activate, because the commitment is under a different domain.
        let mut disguised = abort_token.clone();
        disguised.purpose = PURPOSE_COMMIT.to_string();
        assert_eq!(
            activate(&tgt.conn, &tgt.dir, &disguised.to_json().unwrap(), ID_TARGET).unwrap_err(),
            ERR_TOKEN_INVALID,
            "the abort secret must not open the commit commitment"
        );
        // The parser refuses it even before that, on purpose alone.
        assert_eq!(
            TransferToken::from_json(&abort_token.to_json().unwrap(), PURPOSE_COMMIT).unwrap_err(),
            ERR_TOKEN_INVALID
        );

        // …and the reverse: a commit token cannot abort.
        let s2 = source();
        let t2 = target();
        let (_b2, rec2, _r2) = upto_commit(&s2, &t2);
        let tok = export_commit_token(&s2.conn, &s2.dir, &rec2.transfer_id, s2.install).unwrap();
        let mut d = tok.clone();
        d.purpose = PURPOSE_ABORT.to_string();
        assert_eq!(
            import_abort(&t2.conn, &t2.dir, &d.to_json().unwrap(), ID_TARGET).unwrap_err(),
            ERR_TOKEN_INVALID,
            "the commit secret must not open the abort commitment"
        );
    }

    // ── a leaked abort secret cannot produce a commit ────────────────────────
    #[test]
    fn a_leaked_abort_secret_cannot_commit() {
        let src = source();
        let tgt = target();
        let (b, rec) = issue_from(&src, ID_TARGET);
        import(&tgt.conn, &tgt.dir, &b.to_json().unwrap(), ID_TARGET, PW).unwrap();
        let abort_token =
            abort(&src.conn, &src.dir, &rec.transfer_id, src.install, &src.root()).unwrap();

        // The abort secret is now public — the source hands it out to cancel. Hashed under
        // the COMMIT domain it does not match the package's commit commitment: the two are
        // unrelated values, not one value with a flag.
        let leaked = Secret32::from_b64(&abort_token.secret).unwrap();
        let as_commit = commitment(
            canonical::DOMAIN_TRANSFER_COMMIT,
            &rec.transfer_id,
            ID_TARGET,
            &rec.target_authority_id,
            &rec.target_certificate_hash,
            &leaked,
        );
        assert_ne!(as_commit, rec.commit_secret_hash, "domain separation holds");
        assert_eq!(
            commitment(
                canonical::DOMAIN_TRANSFER_ABORT,
                &rec.transfer_id,
                ID_TARGET,
                &rec.target_authority_id,
                &rec.target_certificate_hash,
                &leaked
            ),
            rec.abort_secret_hash,
            "…but it does open the abort commitment, which is what it is for"
        );
    }

    // ── T12: a repeated import is idempotent ─────────────────────────────────
    #[test]
    fn t12_double_import_is_idempotent() {
        let src = source();
        let (b, rec) = issue_from(&src, ID_TARGET);
        let tgt = target();
        let raw = b.to_json().unwrap();

        assert_eq!(import(&tgt.conn, &tgt.dir, &raw, ID_TARGET, PW).unwrap(), ImportOutcome::Imported);
        assert_eq!(
            import(&tgt.conn, &tgt.dir, &raw, ID_TARGET, PW).unwrap(),
            ImportOutcome::AlreadyImported,
            "T12: byte-identical re-import is a no-op"
        );
        let n: i64 =
            tgt.conn.query_row("SELECT COUNT(*) FROM root_custody", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "no second custody row");
        assert_eq!(tgt.custody(), Some(CustodyState::TargetPending));

        // A contradicting package under the same transfer id is refused, not resolved.
        let src2 = source();
        let (mut b2, _r2) = issue_from(&src2, ID_TARGET);
        b2.transfer_id = rec.transfer_id.clone();
        b2.checksum = b2.compute_checksum();
        assert_eq!(
            import(&tgt.conn, &tgt.dir, &b2.to_json().unwrap(), ID_TARGET, PW).unwrap_err(),
            ERR_TRANSFER_CONFLICT
        );
    }

    // ── T13/T21: repeated commit idempotent; the token survives a crash ──────
    #[test]
    fn t13_t21_double_commit_idempotent_and_token_reexportable() {
        let src = source();
        let tgt = target();
        let (_b, rec, _r) = upto_commit(&src, &tgt);

        // T13 — committing again is success, not a second commit.
        assert!(commit(&src.conn, &rec.transfer_id, src.install, &src.owner).is_ok());
        assert_eq!(src.custody(), Some(CustodyState::SourceRetired));

        // T21 — the token comes from sealed state, so "the process died after T5" costs
        // nothing: export it as often as needed, and it is the same token.
        let t1 = export_commit_token(&src.conn, &src.dir, &rec.transfer_id, src.install).unwrap();
        let t2 = export_commit_token(&src.conn, &src.dir, &rec.transfer_id, src.install).unwrap();
        assert_eq!(t1.secret, t2.secret, "T21: re-exportable and stable");
        assert_eq!(t1.purpose, PURPOSE_COMMIT);
    }

    // ── T14/T15: abort before and after the import ───────────────────────────
    #[test]
    fn t14_t15_abort_before_and_after_import() {
        // T14 — abort before the target ever saw the package.
        {
            let src = source();
            let (_b, rec) = issue_from(&src, ID_TARGET);
            let token =
                abort(&src.conn, &src.dir, &rec.transfer_id, src.install, &src.root()).unwrap();
            assert_eq!(token.purpose, PURPOSE_ABORT);
            assert_eq!(
                load_transfer(&src.conn, &rec.transfer_id).unwrap().state,
                TransferState::Aborted
            );
            // §10 — the source keeps everything.
            assert_eq!(src.custody(), Some(CustodyState::SourceActive));
            assert!(src.active_authority_id().is_some());
        }
        // T15 — abort after import and receipt.
        {
            let src = source();
            let tgt = target();
            let (b, rec) = issue_from(&src, ID_TARGET);
            import(&tgt.conn, &tgt.dir, &b.to_json().unwrap(), ID_TARGET, PW).unwrap();
            let receipt = create_receipt(&tgt.conn, &tgt.dir, &rec.transfer_id, ID_TARGET).unwrap();
            confirm_receipt(
                &src.conn,
                &src.dir,
                &receipt.to_json().unwrap(),
                src.install,
                &src.root(),
            )
            .unwrap();

            let token =
                abort(&src.conn, &src.dir, &rec.transfer_id, src.install, &src.root()).unwrap();
            assert_eq!(src.custody(), Some(CustodyState::SourceActive), "source keeps custody");

            import_abort(&tgt.conn, &tgt.dir, &token.to_json().unwrap(), ID_TARGET).unwrap();
            assert_eq!(tgt.custody(), Some(CustodyState::Aborted));
            assert!(
                !trust_root::pending_key_exists(&tgt.dir, &rec.transfer_id),
                "the pending key is gone"
            );
            assert!(!trust_root::key_file_exists(&tgt.dir), "and no active key was ever created");
            // Idempotent.
            assert!(import_abort(&tgt.conn, &tgt.dir, &token.to_json().unwrap(), ID_TARGET).is_ok());
        }
    }

    // ── a target that never hears about the abort simply cannot sign ─────────
    #[test]
    fn a_target_without_an_abort_token_stays_pending() {
        let src = source();
        let tgt = target();
        let (b, rec) = issue_from(&src, ID_TARGET);
        import(&tgt.conn, &tgt.dir, &b.to_json().unwrap(), ID_TARGET, PW).unwrap();
        abort(&src.conn, &src.dir, &rec.transfer_id, src.install, &src.root()).unwrap();

        // The target heard nothing. §10: it stays pending, which means it cannot sign. The
        // failure mode of a lost abort token is "the new machine does nothing", not "two
        // machines both think they are in charge".
        assert_eq!(tgt.custody(), Some(CustodyState::TargetPending));
        assert_eq!(
            require_custody(&tgt.conn, "tenant-1", ID_TARGET).unwrap_err(),
            ERR_CUSTODY_PENDING
        );
    }

    // ── T22: abort after commit is refused ───────────────────────────────────
    #[test]
    fn t22_abort_after_commit_is_refused() {
        let src = source();
        let tgt = target();
        let (_b, rec, _r) = upto_commit(&src, &tgt);
        assert_eq!(
            abort(&src.conn, &src.dir, &rec.transfer_id, src.install, &src.root()).unwrap_err(),
            ERR_TRANSFER_ALREADY_COMMITTED
        );
        assert_eq!(
            load_transfer(&src.conn, &rec.transfer_id).unwrap().state,
            TransferState::Committed
        );
        assert_eq!(src.custody(), Some(CustodyState::SourceRetired), "a refused abort changes nothing");

        // …and after activation, the target refuses an abort import too.
        let token = export_commit_token(&src.conn, &src.dir, &rec.transfer_id, src.install).unwrap();
        activate(&tgt.conn, &tgt.dir, &token.to_json().unwrap(), ID_TARGET).unwrap();
        let fake_abort = TransferToken {
            format_version: TRANSFER_FORMAT_VERSION,
            purpose: PURPOSE_ABORT.to_string(),
            transfer_id: rec.transfer_id.clone(),
            secret: b64(&[1u8; 32]),
            issued_at: "n".into(),
            target_certificate_hash: rec.target_certificate_hash.clone(),
        };
        assert_eq!(
            import_abort(&tgt.conn, &tgt.dir, &fake_abort.to_json().unwrap(), ID_TARGET).unwrap_err(),
            ERR_TRANSFER_ALREADY_COMMITTED
        );
        assert_eq!(tgt.custody(), Some(CustodyState::TargetActive));
    }

    // ── T17: the source cannot sign after the commit ─────────────────────────
    #[test]
    fn t17_source_cannot_sign_after_commit() {
        let src = source();
        let tgt = target();
        let (_b, _rec, _r) = upto_commit(&src, &tgt);

        // The root key FILE is still there, and so is the primary role. Neither is
        // permission — which is exactly why "the file exists" was never a sufficient gate.
        assert!(trust_root::key_file_exists(&src.dir), "the file survives, deliberately");
        assert_eq!(
            require_custody(&src.conn, "tenant-1", src.install).unwrap_err(),
            ERR_CUSTODY_RETIRED
        );
        assert_eq!(
            authority::require_signing_authority(
                &src.conn,
                "tenant-1",
                "branch-main",
                src.install,
                State::Primary,
                &src.root()
            )
            .unwrap_err(),
            ERR_CUSTODY_RETIRED,
            "T17: the §9 gate refuses on custody, not on the file"
        );
        // A second transfer is therefore impossible too.
        let root = src.root();
        let key = src.key();
        let req = IssueRequest {
            conn: &src.conn,
            tenant_id: "tenant-1",
            branch_id: "branch-main",
            install_id: src.install,
            primary_state: State::Primary,
            root: &root,
            key: &key,
            owner: &src.owner,
        };
        assert_eq!(
            issue(&req, ID_OTHER, PW, PW, TRANSFER_CONFIRMATION).unwrap_err(),
            ERR_CUSTODY_RETIRED
        );
    }

    // ── T18: the target signs after activation AND explicit primary config ───
    #[test]
    fn t18_target_signs_after_activation_and_separate_primary_config() {
        let src = source();
        let tgt = target();
        let (_b, rec, _r) = upto_commit(&src, &tgt);
        let token = export_commit_token(&src.conn, &src.dir, &rec.transfer_id, src.install).unwrap();
        activate(&tgt.conn, &tgt.dir, &token.to_json().unwrap(), ID_TARGET).unwrap();

        // The transfer moved custody. It did NOT make the target a primary — that role is a
        // separate, explicit decision (M6-B2A), and a transfer that granted it silently
        // would put implicit promotion straight back.
        assert_eq!(
            authority::require_signing_authority(
                &tgt.conn,
                "tenant-1",
                "branch-main",
                ID_TARGET,
                State::Client,
                &tgt.root()
            )
            .unwrap_err(),
            authority::ERR_NOT_PRIMARY,
            "custody alone is not the primary role"
        );
        // Configured as primary — separately and on purpose — it signs.
        let current = authority::require_signing_authority(
            &tgt.conn,
            "tenant-1",
            "branch-main",
            ID_TARGET,
            State::Primary,
            &tgt.root(),
        )
        .unwrap();
        assert_eq!(current.authority_id, rec.target_authority_id);
        assert_eq!(current.authority_epoch, 2);

        // And it really signs: a verifiable certificate under the SAME tenant root.
        let key = tgt.key();
        let cert = authority::sign_transfer_certificate(
            "tenant-1",
            "branch-main",
            &tgt.root(),
            &key,
            3,
            ID_OTHER,
            Some(current.authority_id),
        )
        .unwrap();
        assert!(authority::verify_certificate(
            &cert,
            &authority::VerifyContext {
                tenant_id: "tenant-1",
                branch_id: "branch-main",
                root: &tgt.root(),
                expect_instance: Some(ID_OTHER),
            }
        )
        .is_ok());
        // Same root: the ABILITY moved. This is the whole point of the slice — the old
        // transfer moved a certificate and left the signing ability behind.
        assert_eq!(tgt.root().public_key, src.root().public_key);
        assert_eq!(tgt.root().root_key_id, src.root().root_key_id);
    }

    // ── T16: crash / resume at every transition ──────────────────────────────
    #[test]
    fn t16_crash_resume_at_every_transition() {
        let src = source();
        let tgt = target();
        let (b, rec) = issue_from(&src, ID_TARGET);
        let raw = b.to_json().unwrap();

        // after T1 — the package is a value we hold; re-serialising is stable.
        assert_eq!(b.to_json().unwrap(), raw);

        // after import — idempotent
        import(&tgt.conn, &tgt.dir, &raw, ID_TARGET, PW).unwrap();
        assert_eq!(
            import(&tgt.conn, &tgt.dir, &raw, ID_TARGET, PW).unwrap(),
            ImportOutcome::AlreadyImported
        );

        // after receipt — re-creatable and identical (derived from sealed state, not stored)
        let r1 = create_receipt(&tgt.conn, &tgt.dir, &rec.transfer_id, ID_TARGET).unwrap();
        let r2 = create_receipt(&tgt.conn, &tgt.dir, &rec.transfer_id, ID_TARGET).unwrap();
        assert_eq!(r1.mac, r2.mac, "the receipt survives a crash");

        // after source confirmation — repeatable
        let raw_r = r1.to_json().unwrap();
        confirm_receipt(&src.conn, &src.dir, &raw_r, src.install, &src.root()).unwrap();
        confirm_receipt(&src.conn, &src.dir, &raw_r, src.install, &src.root()).unwrap();

        // commit — repeatable
        commit(&src.conn, &rec.transfer_id, src.install, &src.owner).unwrap();
        commit(&src.conn, &rec.transfer_id, src.install, &src.owner).unwrap();

        // commit token — re-exportable after the commit
        let token = export_commit_token(&src.conn, &src.dir, &rec.transfer_id, src.install).unwrap();

        // activation — idempotent
        activate(&tgt.conn, &tgt.dir, &token.to_json().unwrap(), ID_TARGET).unwrap();
        assert_eq!(
            activate(&tgt.conn, &tgt.dir, &token.to_json().unwrap(), ID_TARGET).unwrap(),
            ActivateOutcome::AlreadyActive
        );
        assert_eq!(tgt.custody(), Some(CustodyState::TargetActive));

        // …and the receipt is STILL re-creatable after activation, when the seed has moved
        // from the pending name to the active one.
        let r3 = create_receipt(&tgt.conn, &tgt.dir, &rec.transfer_id, ID_TARGET).unwrap();
        assert_eq!(r3.mac, r1.mac, "the same receipt, from the now-active key");
    }

    // ── the crash the file-before-DB order exists for ────────────────────────
    #[test]
    fn crash_after_key_publication_before_db_commit_resumes() {
        let src = source();
        let tgt = target();
        let (_b, rec, _r) = upto_commit(&src, &tgt);
        let token = export_commit_token(&src.conn, &src.dir, &rec.transfer_id, src.install).unwrap();

        // Simulate the crash window: the key file has been published, the DB has not been
        // updated. This is exactly what a power cut between the two leaves behind.
        let seed = trust_root::load_pending_seed(&tgt.dir, &rec.transfer_id).unwrap();
        assert_eq!(
            trust_root::publish_pending_as_active(&tgt.dir, &rec.transfer_id, &seed).unwrap(),
            trust_root::PublishOutcome::Published
        );
        assert!(trust_root::key_file_exists(&tgt.dir), "the file is there…");
        assert_eq!(tgt.custody(), Some(CustodyState::TargetPending), "…and the DB says pending");

        // The dangerous-looking half-state is SAFE, because the gate asks the DB, not the
        // filesystem. This is the payoff for the file-first order.
        assert_eq!(
            require_custody(&tgt.conn, "tenant-1", ID_TARGET).unwrap_err(),
            ERR_CUSTODY_PENDING,
            "an active key file is not permission to sign"
        );

        // The retry finds the identical file and finishes the DB half.
        assert_eq!(
            activate(&tgt.conn, &tgt.dir, &token.to_json().unwrap(), ID_TARGET).unwrap(),
            ActivateOutcome::Activated
        );
        assert_eq!(tgt.custody(), Some(CustodyState::TargetActive));
    }

    // ── a contradicting active root file is fail-closed ──────────────────────
    #[test]
    fn a_conflicting_active_root_file_is_never_overwritten() {
        let src = source();
        let tgt = target();
        let (_b, rec, _r) = upto_commit(&src, &tgt);

        // Put a DIFFERENT tenant root under the active name on the target, as a restored
        // backup or a stray copy would.
        let foreign = source();
        std::fs::copy(
            trust_root::testkit::key_file_path(&foreign.dir),
            trust_root::testkit::key_file_path(&tgt.dir),
        )
        .unwrap();

        let token = export_commit_token(&src.conn, &src.dir, &rec.transfer_id, src.install).unwrap();
        assert_eq!(
            activate(&tgt.conn, &tgt.dir, &token.to_json().unwrap(), ID_TARGET).unwrap_err(),
            trust_root::ERR_ROOT_KEY_ALREADY_EXISTS,
            "an existing, different root key must never be clobbered"
        );
        assert_eq!(tgt.custody(), Some(CustodyState::TargetPending));
        // The foreign key is untouched — we refuse, we do not "fix".
        let after = std::fs::read_to_string(trust_root::testkit::key_file_path(&tgt.dir)).unwrap();
        let expect = std::fs::read_to_string(trust_root::testkit::key_file_path(&foreign.dir)).unwrap();
        assert_eq!(after, expect);
    }

    // ── T19: tampering with any artefact is refused ──────────────────────────
    #[test]
    fn t19_tampered_artefacts_are_refused() {
        let src = source();
        let tgt = target();
        let (b, rec) = issue_from(&src, ID_TARGET);

        // package: every AAD-bound field
        let mutations: Vec<fn(&mut TransferBundle)> = vec![
            |x: &mut TransferBundle| x.tenant_id = "tenant-2".into(),
            |x: &mut TransferBundle| x.root_generation = 99,
            |x: &mut TransferBundle| x.source_authority_id = "aaaaaaaa-0000-4000-8000-000000000001".into(),
            |x: &mut TransferBundle| x.commit_secret_hash = "bb".repeat(32),
        ];
        for mutate in mutations {
            let mut bad = b.clone();
            mutate(&mut bad);
            bad.checksum = bad.compute_checksum();
            let t = target();
            assert!(
                import(&t.conn, &t.dir, &bad.to_json().unwrap(), ID_TARGET, PW).is_err(),
                "an AAD-bound edit must break decryption, not merely fail a comparison"
            );
        }
        // a flipped ciphertext byte
        {
            let mut bad = b.clone();
            let mut ct = unb64(&b.ciphertext).unwrap();
            ct[0] ^= 0x01;
            bad.ciphertext = b64(&ct);
            bad.checksum = bad.compute_checksum();
            let t = target();
            assert_eq!(
                import(&t.conn, &t.dir, &bad.to_json().unwrap(), ID_TARGET, PW).unwrap_err(),
                ERR_TRANSFER_INVALID
            );
        }
        // a broken checksum is caught before the KDF
        {
            let mut bad = b.clone();
            bad.checksum = "cc".repeat(32);
            assert_eq!(
                import(&tgt.conn, &tgt.dir, &bad.to_json().unwrap(), ID_TARGET, PW).unwrap_err(),
                ERR_TRANSFER_INVALID
            );
        }
        // wrong passphrase
        assert_eq!(
            import(&tgt.conn, &tgt.dir, &b.to_json().unwrap(), ID_TARGET, "wrong-passphrase-x")
                .unwrap_err(),
            ERR_TRANSFER_INVALID
        );

        // receipt: every MAC'd field
        import(&tgt.conn, &tgt.dir, &b.to_json().unwrap(), ID_TARGET, PW).unwrap();
        let good = create_receipt(&tgt.conn, &tgt.dir, &rec.transfer_id, ID_TARGET).unwrap();
        let rmuts: Vec<fn(&mut TargetReceipt)> = vec![
            |x: &mut TargetReceipt| x.target_install_id = ID_OTHER.into(),
            |x: &mut TargetReceipt| x.root_generation = 42,
            |x: &mut TargetReceipt| x.imported_at = "2099-01-01T00:00:00Z".into(),
            |x: &mut TargetReceipt| x.target_authority_id = "aaaaaaaa-0000-4000-8000-000000000002".into(),
        ];
        for mutate in rmuts {
            let mut bad = good.clone();
            mutate(&mut bad);
            assert!(
                confirm_receipt(&src.conn, &src.dir, &bad.to_json().unwrap(), src.install, &src.root())
                    .is_err(),
                "every MAC'd field must be covered"
            );
        }
    }

    // ── T20: no secret ever reaches text ─────────────────────────────────────
    #[test]
    fn t20_no_secret_reaches_logs_certificates_or_errors() {
        use base64::Engine;
        let src = source();
        let tgt = target();
        let (b, rec, receipt) = upto_commit(&src, &tgt);
        let token = export_commit_token(&src.conn, &src.dir, &rec.transfer_id, src.install).unwrap();

        let seed = *src.key().seed();
        let seed_b64 = base64::engine::general_purpose::STANDARD.encode(seed);
        let seed_hex: String = seed.iter().map(|x| format!("{x:02x}")).collect();

        let cert = authority::AuthorityCertificate::from_json(&rec.target_certificate).unwrap();
        let surfaces = vec![
            b.to_json().unwrap(),
            receipt.to_json().unwrap(),
            rec.target_certificate.clone(),
            cert.to_json().unwrap(),
            format!("{rec:?}"),
            format!("{b:?}"),
            format!("{receipt:?}"),
            format!("{cert:?}"),
        ];
        for s in &surfaces {
            assert!(!s.contains(&seed_b64), "the root seed must never appear");
            assert!(!s.contains(&seed_hex));
            assert!(!s.contains(PW), "the passphrase must never appear");
            assert!(!s.contains(&token.secret), "the commit secret must never appear");
        }
        // The commit token DOES carry its secret — that is what it is for — but the receipt
        // in particular must not.
        assert!(!receipt.to_json().unwrap().contains(&token.secret));

        // Secret32's Debug is hand-written and redacted, not derived.
        let s = Secret32::random().unwrap();
        let dbg = format!("{s:?}");
        assert!(dbg.contains("redacted"));
        assert!(!dbg.contains(&s.to_b64()));

        // Every error code is a constant, not a formatted value that could carry data.
        for e in [ERR_TRANSFER_INVALID, ERR_RECEIPT_INVALID, ERR_TOKEN_INVALID, ERR_CUSTODY_RETIRED] {
            assert!(!e.contains(&seed_hex));
            assert!(e.chars().all(|c| c.is_ascii_uppercase() || c == '_'));
        }
    }

    // ── T24: the confirmation level is the honest one, everywhere ────────────
    #[test]
    fn t24_confirmation_level_is_exactly_the_honest_string() {
        let src = source();
        let tgt = target();
        let (_b, rec, receipt) = upto_commit(&src, &tgt);

        assert_eq!(CONFIRMATION_LEVEL, "locally_confirmed_not_device_attested");
        assert_eq!(receipt.confirmation_level, CONFIRMATION_LEVEL, "in the receipt");
        assert_eq!(
            load_transfer(&src.conn, &rec.transfer_id).unwrap().confirmation_level.as_deref(),
            Some(CONFIRMATION_LEVEL),
            "in the source's DB"
        );
        assert_eq!(
            load_transfer(&tgt.conn, &rec.transfer_id).unwrap().confirmation_level.as_deref(),
            Some(CONFIRMATION_LEVEL),
            "in the target's DB"
        );

        // A receipt that upgrades its own claim is refused by the parser — and the level is
        // inside the MAC anyway, so editing it breaks the MAC too. Two independent reasons.
        let mut lying = receipt.clone();
        lying.confirmation_level = "device_attested".into();
        assert_eq!(
            TargetReceipt::from_json(&lying.to_json().unwrap()).unwrap_err(),
            ERR_RECEIPT_INVALID
        );
        // And the DB refuses the value outright — the CHECK constraint is the last word.
        assert!(
            src.conn
                .execute(
                    "UPDATE authority_transfers SET confirmation_level = 'device_attested'
                      WHERE transfer_id = ?1",
                    params![rec.transfer_id],
                )
                .is_err(),
            "the CHECK constraint is the last word"
        );
    }

    // ── §12: the strict bundle parser ────────────────────────────────────────
    #[test]
    fn strict_bundle_parser_refuses_everything_that_is_not_ours() {
        let src = source();
        let (b, _rec) = issue_from(&src, ID_TARGET);
        let raw = b.to_json().unwrap();

        // unknown field
        let mut v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        v.as_object_mut().unwrap().insert("extra".into(), serde_json::json!(1));
        assert_eq!(TransferBundle::from_json(&v.to_string()).unwrap_err(), ERR_TRANSFER_INVALID);

        // missing required field
        let mut v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        v.as_object_mut().unwrap().remove("transfer_id");
        assert_eq!(TransferBundle::from_json(&v.to_string()).unwrap_err(), ERR_TRANSFER_INVALID);

        // wrong type
        let mut v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        v["root_generation"] = serde_json::json!("one");
        assert_eq!(TransferBundle::from_json(&v.to_string()).unwrap_err(), ERR_TRANSFER_INVALID);

        // oversize id
        let mut v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        v["tenant_id"] = serde_json::json!("x".repeat(MAX_ID_LEN + 1));
        assert_eq!(TransferBundle::from_json(&v.to_string()).unwrap_err(), ERR_TRANSFER_INVALID);

        // oversize file
        assert_eq!(
            TransferBundle::from_json(&"x".repeat(MAX_TRANSFER_BYTES + 1)).unwrap_err(),
            ERR_TRANSFER_INVALID
        );

        // A weak KDF is refused BEFORE the KDF runs…
        let mut v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        v["kdf_parameters"]["m_cost_kib"] = serde_json::json!(8);
        assert_eq!(TransferBundle::from_json(&v.to_string()).unwrap_err(), ERR_TRANSFER_INVALID);
        // …and so is a memory bomb. Both ends of the range matter.
        let mut v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        v["kdf_parameters"]["m_cost_kib"] = serde_json::json!(16 * 1024 * 1024);
        assert_eq!(TransferBundle::from_json(&v.to_string()).unwrap_err(), ERR_TRANSFER_INVALID);

        // exact encodings
        for (field, val) in [
            ("nonce", b64(&[0u8; 11])),
            ("salt", b64(&[0u8; 15])),
            ("ciphertext", b64(&[0u8; 10])),
        ] {
            let mut v: serde_json::Value = serde_json::from_str(&raw).unwrap();
            v[field] = serde_json::json!(val);
            assert_eq!(
                TransferBundle::from_json(&v.to_string()).unwrap_err(),
                ERR_TRANSFER_INVALID,
                "{field} has a fixed length"
            );
        }

        // equal commit/abort commitments are structurally impossible
        let mut v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        v["abort_secret_hash"] = v["commit_secret_hash"].clone();
        assert_eq!(TransferBundle::from_json(&v.to_string()).unwrap_err(), ERR_TRANSFER_INVALID);

        // a transfer to oneself
        let mut v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        v["target_install_id"] = v["source_install_id"].clone();
        assert_eq!(TransferBundle::from_json(&v.to_string()).unwrap_err(), ERR_TRANSFER_INVALID);

        // a non-hex hash
        let mut v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        v["target_certificate_hash"] = serde_json::json!("z".repeat(64));
        assert_eq!(TransferBundle::from_json(&v.to_string()).unwrap_err(), ERR_TRANSFER_INVALID);

        // version
        let mut v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        v["format_version"] = serde_json::json!(2);
        assert_eq!(TransferBundle::from_json(&v.to_string()).unwrap_err(), ERR_TRANSFER_INVALID);

        // the good one still parses — otherwise the assertions above prove nothing
        assert!(TransferBundle::from_json(&raw).is_ok());
    }

    // ── §12: token and receipt parsers ───────────────────────────────────────
    #[test]
    fn token_and_receipt_parsers_are_strict() {
        let src = source();
        let tgt = target();
        let (_b, rec, receipt) = upto_commit(&src, &tgt);
        let token = export_commit_token(&src.conn, &src.dir, &rec.transfer_id, src.install).unwrap();
        let raw_t = token.to_json().unwrap();
        let raw_r = receipt.to_json().unwrap();

        // token: unknown field
        let mut v: serde_json::Value = serde_json::from_str(&raw_t).unwrap();
        v.as_object_mut().unwrap().insert("extra".into(), serde_json::json!(1));
        assert_eq!(
            TransferToken::from_json(&v.to_string(), PURPOSE_COMMIT).unwrap_err(),
            ERR_TOKEN_INVALID
        );
        // token: missing field
        let mut v: serde_json::Value = serde_json::from_str(&raw_t).unwrap();
        v.as_object_mut().unwrap().remove("secret");
        assert_eq!(
            TransferToken::from_json(&v.to_string(), PURPOSE_COMMIT).unwrap_err(),
            ERR_TOKEN_INVALID
        );
        // token: a secret is exactly 32 bytes
        let mut v: serde_json::Value = serde_json::from_str(&raw_t).unwrap();
        v["secret"] = serde_json::json!(b64(&[0u8; 31]));
        assert_eq!(
            TransferToken::from_json(&v.to_string(), PURPOSE_COMMIT).unwrap_err(),
            ERR_TOKEN_INVALID
        );
        // token: version
        let mut v: serde_json::Value = serde_json::from_str(&raw_t).unwrap();
        v["format_version"] = serde_json::json!(9);
        assert_eq!(
            TransferToken::from_json(&v.to_string(), PURPOSE_COMMIT).unwrap_err(),
            ERR_TOKEN_INVALID
        );
        // oversize
        assert_eq!(
            TransferToken::from_json(&"x".repeat(MAX_TOKEN_BYTES + 1), PURPOSE_COMMIT).unwrap_err(),
            ERR_TOKEN_INVALID
        );
        assert_eq!(
            TargetReceipt::from_json(&"x".repeat(MAX_RECEIPT_BYTES + 1)).unwrap_err(),
            ERR_RECEIPT_INVALID
        );

        // receipt: unknown field
        let mut v: serde_json::Value = serde_json::from_str(&raw_r).unwrap();
        v.as_object_mut().unwrap().insert("extra".into(), serde_json::json!(1));
        assert_eq!(TargetReceipt::from_json(&v.to_string()).unwrap_err(), ERR_RECEIPT_INVALID);
        // receipt: mac length
        let mut v: serde_json::Value = serde_json::from_str(&raw_r).unwrap();
        v["mac"] = serde_json::json!(b64(&[0u8; 31]));
        assert_eq!(TargetReceipt::from_json(&v.to_string()).unwrap_err(), ERR_RECEIPT_INVALID);

        // Cross-parsing: a receipt is not a token, a token is not a receipt.
        assert_eq!(TransferToken::from_json(&raw_r, PURPOSE_COMMIT).unwrap_err(), ERR_TOKEN_INVALID);
        assert_eq!(TargetReceipt::from_json(&raw_t).unwrap_err(), ERR_RECEIPT_INVALID);

        // The good ones still parse.
        assert!(TransferToken::from_json(&raw_t, PURPOSE_COMMIT).is_ok());
        assert!(TargetReceipt::from_json(&raw_r).is_ok());
    }

    // ── §13: recovery_pending is never activated by a transfer ───────────────
    #[test]
    fn recovery_pending_is_never_touched_by_a_transfer() {
        let src = source();
        let tgt = target();
        let (_b, rec, _r) = upto_commit(&src, &tgt);
        let token = export_commit_token(&src.conn, &src.dir, &rec.transfer_id, src.install).unwrap();
        activate(&tgt.conn, &tgt.dir, &token.to_json().unwrap(), ID_TARGET).unwrap();

        let n: i64 = tgt
            .conn
            .query_row(
                "SELECT COUNT(*) FROM authority_certificates WHERE status = 'recovery_pending'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0, "a transfer never produces or promotes a recovery_pending certificate");

        // Only target_pending from THIS transfer became active — no other custody exists.
        let states: Vec<String> = tgt
            .conn
            .prepare("SELECT state FROM root_custody")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(states, vec!["target_active".to_string()]);
    }

    // ── §3: the DB enforces the custody invariant, not just the code ─────────
    #[test]
    fn the_database_forbids_two_active_custodies() {
        let src = source();
        assert_eq!(src.custody(), Some(CustodyState::SourceActive));
        // A second active custody for the same tenant, inserted behind the code's back.
        let r = src.conn.execute(
            "INSERT INTO root_custody
               (tenant_id, root_key_id, root_generation, install_id, transfer_id, state,
                created_at, activated_at)
             VALUES ('tenant-1','other-root',1,?1,NULL,'target_active','n','n')",
            params![ID_OTHER],
        );
        assert!(r.is_err(), "the partial unique index must forbid a second active custody");
    }

    // ── §8 T1: the confirmation string and the passphrase rules ──────────────
    #[test]
    fn issue_requires_the_confirmation_and_a_real_passphrase() {
        let src = source();
        let root = src.root();
        let key = src.key();
        let req = IssueRequest {
            conn: &src.conn,
            tenant_id: "tenant-1",
            branch_id: "branch-main",
            install_id: src.install,
            primary_state: State::Primary,
            root: &root,
            key: &key,
            owner: &src.owner,
        };
        for bad in ["", "yes", "TRANSFER_AUTHORITY", "transfer_authority_to_the_target_installation"] {
            assert_eq!(issue(&req, ID_TARGET, PW, PW, bad).unwrap_err(), ERR_NOT_CONFIRMED);
        }
        assert_eq!(
            issue(&req, ID_TARGET, "short", "short", TRANSFER_CONFIRMATION).unwrap_err(),
            ERR_PASSWORD_TOO_WEAK
        );
        assert_eq!(
            issue(&req, ID_TARGET, PW, "different", TRANSFER_CONFIRMATION).unwrap_err(),
            ERR_PASSWORD_MISMATCH
        );
        // A transfer to oneself.
        assert_eq!(
            issue(&req, ID_SOURCE, PW, PW, TRANSFER_CONFIRMATION).unwrap_err(),
            ERR_TRANSFER_INVALID
        );
        // A refused issue writes nothing at all.
        let n: i64 = src
            .conn
            .query_row("SELECT COUNT(*) FROM authority_transfers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
        assert_eq!(src.custody(), Some(CustodyState::SourceActive));
    }

    // ── only one transfer may be in flight ───────────────────────────────────
    #[test]
    fn only_one_transfer_can_be_in_flight() {
        let src = source();
        issue_from(&src, ID_TARGET);
        let root = src.root();
        let key = src.key();
        let req = IssueRequest {
            conn: &src.conn,
            tenant_id: "tenant-1",
            branch_id: "branch-main",
            install_id: src.install,
            primary_state: State::Primary,
            root: &root,
            key: &key,
            owner: &src.owner,
        };
        assert_eq!(
            issue(&req, ID_OTHER, PW, PW, TRANSFER_CONFIRMATION).unwrap_err(),
            ERR_TRANSFER_IN_FLIGHT,
            "two concurrent handovers would each retire the source"
        );
    }

    // ── the states themselves ────────────────────────────────────────────────
    #[test]
    fn states_round_trip_and_only_two_may_sign() {
        for s in [
            CustodyState::SourceActive,
            CustodyState::TargetPending,
            CustodyState::TargetActive,
            CustodyState::SourceRetired,
            CustodyState::Aborted,
            CustodyState::Invalid,
        ] {
            assert_eq!(CustodyState::parse(s.as_str()), Some(s));
            assert_eq!(
                s.may_sign(),
                matches!(s, CustodyState::SourceActive | CustodyState::TargetActive)
            );
        }
        assert_eq!(CustodyState::parse("something_else"), None);

        for s in [
            TransferState::IssuedPending,
            TransferState::TargetImported,
            TransferState::TargetConfirmed,
            TransferState::Committed,
            TransferState::TargetActivated,
            TransferState::Aborted,
            TransferState::Invalid,
        ] {
            assert_eq!(TransferState::parse(s.as_str()), Some(s));
            assert_eq!(
                s.may_abort(),
                matches!(
                    s,
                    TransferState::IssuedPending
                        | TransferState::TargetImported
                        | TransferState::TargetConfirmed
                ),
                "abort is only possible before the commit"
            );
        }
        assert_eq!(TransferState::parse("committed_maybe"), None);
    }

    // ── §5: the sealed secrets need the root, not just the DB ────────────────
    #[test]
    fn sealed_secrets_are_unreadable_without_the_root_key() {
        let src = source();
        let (_b, rec) = issue_from(&src, ID_TARGET);

        // The sealed blobs are in the DB…
        let (sealed, nonce) = sealed_pair(&src.conn, &rec.transfer_id, "commit").unwrap();
        assert_eq!(unb64(&sealed).unwrap().len(), SEALED_LEN);
        assert_eq!(unb64(&nonce).unwrap().len(), NONCE_LEN);

        // …and a DIFFERENT root cannot open them. This is what makes a stolen DB file
        // insufficient to commit a transfer.
        let other = source();
        assert!(
            open_secret(other.key().seed(), &rec, PURPOSE_COMMIT, &sealed, &nonce).is_err(),
            "a stolen DB without the root key cannot unseal the commit secret"
        );
        // The right root can.
        assert!(open_secret(src.key().seed(), &rec, PURPOSE_COMMIT, &sealed, &nonce).is_ok());

        // The AAD binds the secret's purpose: the commit blob cannot be unsealed AS abort.
        assert!(
            open_secret(src.key().seed(), &rec, PURPOSE_ABORT, &sealed, &nonce).is_err(),
            "the purpose is in the AAD, so a commit blob is not an abort blob"
        );
    }

    // ── §17: tests never touch production paths ──────────────────────────────
    #[test]
    fn tests_never_use_production_appdata() {
        let d = tmp_dir();
        let s = d.to_string_lossy().to_lowercase();
        assert!(s.contains("com.lataif.m6b2bctest20260717"), "isolated identifier");
        assert!(!s.contains("roaming\\com.lataif.app"));
        assert!(!s.contains("roaming/com.lataif.app"));
    }
}
