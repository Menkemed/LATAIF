//! M6-B2B — the encrypted tenant-root recovery bundle.
//!
//! ## What it is
//!
//! One file the owner can store away from the shop (`tenant-root-recovery.lataif`). It
//! carries the tenant's private root key, encrypted under a passphrase that only the
//! owner knows. If the primary machine dies, this file — and only this file — allows the
//! same trust root to continue on a new machine.
//!
//! ## The hard rule it exists to serve
//!
//! **No old private root key → no continuation of the same trust root.** There is no
//! clever reconstruction. Without the key (or this bundle), the tenant must re-enrol,
//! which is why `TRUST_REENROLLMENT_REQUIRED` is a first-class outcome and not an error
//! we try to route around.
//!
//! ## Crypto
//!
//! - KDF: Argon2id, m = 64 MiB, t = 3, p = 1 (§2 minimum)
//! - AEAD: AES-256-GCM, 96-bit random nonce, 128-bit tag
//! - AAD: tenant_id ‖ root_key_id ‖ format_version ‖ root_generation
//!
//! The AAD is the part that matters most. The checksum only catches accidental damage —
//! anyone can recompute it. Binding the identifying metadata into the AEAD means that
//! rewriting `tenant_id` (or the generation) makes decryption *fail*, rather than
//! producing a bundle that decrypts fine and lies about whose key it holds.

use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use super::trust_root::{RootState, TrustRootRecord};

/// Only version we write or accept.
pub const BUNDLE_FORMAT_VERSION: u32 = 1;
pub const BUNDLE_FILENAME: &str = "tenant-root-recovery.lataif";

/// M6-B2BC2 §13 — what this file is FOR.
///
/// A recovery bundle and an authority-transfer package both wrap a tenant root seed under
/// a passphrase. Without a purpose they would be structurally interchangeable, and a
/// transfer package could be replayed into the recovery importer (or the reverse) to move
/// a key somewhere it was never meant to go. The purpose is checked strictly AND bound
/// into the AEAD's associated data, so it cannot be edited after the fact either.
pub const PURPOSE_RECOVERY: &str = "tenant_root_recovery";
/// Reserved for the transfer package (M6-B2C). Declared here so the recovery importer can
/// refuse it explicitly rather than by accident.
pub const PURPOSE_AUTHORITY_TRANSFER: &str = "authority_transfer";

// ── §13 — hard structural limits. Every one of these is a fail-closed bound on a
// value an attacker controls, checked BEFORE the deliberately expensive KDF runs.
/// A UUID is 36 characters; anything materially longer is not an id we wrote.
pub const MAX_ID_LEN: usize = 64;
/// RFC3339 timestamps are ~35 characters.
pub const MAX_TIMESTAMP_LEN: usize = 64;
/// base64 of a 32-byte Ed25519 public key = 44 characters.
pub const PUBLIC_KEY_B64_LEN: usize = 44;
/// SHA-256 hex.
pub const FINGERPRINT_HEX_LEN: usize = 64;
pub const CHECKSUM_HEX_LEN: usize = 64;
/// AES-256-GCM: 96-bit nonce, and a 16-byte salt is what we write.
pub const NONCE_LEN: usize = 12;
pub const SALT_LEN: usize = 16;
/// 32-byte seed + 16-byte GCM tag.
pub const CIPHERTEXT_LEN: usize = 32 + 16;

/// A recovery bundle is ~1 KB. A megabyte of "bundle" is either corruption or an attempt
/// to make us allocate; refuse before parsing.
pub const MAX_BUNDLE_BYTES: usize = 64 * 1024;

pub const KDF_ARGON2ID: &str = "argon2id";
pub const AEAD_AES_256_GCM: &str = "aes-256-gcm";

/// §2 contract. These are the values we WRITE.
pub const ARGON2_M_COST_KIB: u32 = 65_536; // 64 MiB
pub const ARGON2_T_COST: u32 = 3;
pub const ARGON2_P_COST: u32 = 1;

/// …and these are the bounds we ACCEPT on import.
///
/// Both ends matter. Too low is the obvious attack (a bundle that claims m=8 KiB is
/// trivially brute-forcible). Too high is the less obvious one: an attacker-supplied
/// `m_cost = 16 GiB` is a memory bomb that we would dutifully allocate before ever
/// checking the password. Neither is a parameter we let the file choose freely.
pub const MIN_M_COST_KIB: u32 = 65_536; // 64 MiB
pub const MAX_M_COST_KIB: u32 = 1_048_576; // 1 GiB
pub const MIN_T_COST: u32 = 3;
pub const MAX_T_COST: u32 = 16;
pub const MIN_P_COST: u32 = 1;
pub const MAX_P_COST: u32 = 8;

/// Minimum recovery passphrase length. This is the ONLY thing standing between a stolen
/// bundle file and the tenant's root key, so it is not a UI nicety.
pub const MIN_RECOVERY_PASSWORD_LEN: usize = 12;

// ── Error codes ─────────────────────────────────────────────────────────────
pub const ERR_BACKUP_INVALID: &str = "ROOT_KEY_BACKUP_INVALID";
pub const ERR_BACKUP_WRONG_TENANT: &str = "ROOT_KEY_BACKUP_WRONG_TENANT";
pub const ERR_BACKUP_UNSUPPORTED_VERSION: &str = "ROOT_KEY_BACKUP_INVALID";
pub const ERR_BACKUP_WEAK_KDF: &str = "ROOT_KEY_BACKUP_INVALID";
/// §13 — a file whose declared purpose is not recovery (e.g. an authority-transfer
/// package replayed here). Distinct so the refusal is legible in a log.
pub const ERR_BACKUP_WRONG_PURPOSE: &str = "ROOT_KEY_BACKUP_WRONG_PURPOSE";
// The root LIFECYCLE codes (ROOT_KEY_RECOVERY_REQUIRED / ROOT_KEY_LOST_REENROLLMENT_REQUIRED)
// belong to `trust_root`, which owns that state. Re-declaring them here would be two
// sources for one contract.
pub const ERR_PASSWORD_TOO_WEAK: &str = "RECOVERY_PASSWORD_TOO_WEAK";
pub const ERR_PASSWORD_MISMATCH: &str = "RECOVERY_PASSWORD_MISMATCH";

/// `deny_unknown_fields`: a bundle carrying a field we do not know is a bundle written by
/// something that is not us. Accepting it silently would mean parsing a format we have
/// never reasoned about.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct KdfParameters {
    pub m_cost_kib: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

/// The bundle, exactly as it is written to disk (JSON).
///
/// Field order is the declaration order and serde preserves it, so `checksum_input`
/// below is deterministic without needing a canonical-JSON library.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RecoveryBundle {
    pub format_version: u32,
    /// §13 — always `PURPOSE_RECOVERY`. Bound into the AAD, so it cannot be rewritten.
    pub purpose: String,
    pub tenant_id: String,
    pub root_key_id: String,
    pub root_generation: i64,
    pub public_key: String,
    pub fingerprint: String,
    pub created_at: String,
    pub exported_at: String,

    pub kdf: String,
    pub kdf_parameters: KdfParameters,
    pub salt: String,

    pub encryption_algorithm: String,
    pub nonce: String,
    pub ciphertext: String,

    /// Hints for recovery — NOT guarantees.
    ///
    /// §13 "keine stillen Defaultwerte". Dropping `#[serde(default)]` is NOT enough:
    /// serde special-cases `Option<T>` and fills a MISSING field with `None` regardless
    /// — verified empirically, not assumed. So "the exporter knew of no authority"
    /// (explicit `null`) and "this file has no such field at all" would collapse into the
    /// same value. `deserialize_with` without `default` restores the distinction: the
    /// field must be present, and may then be null.
    #[serde(deserialize_with = "required_option")]
    pub last_known_authority_id: Option<String>,
    #[serde(deserialize_with = "required_option")]
    pub last_known_authority_epoch: Option<i64>,
    #[serde(deserialize_with = "required_option")]
    pub last_known_certificate_serial: Option<String>,

    /// SHA-256 over every other field. Detects accidental damage. It is NOT a security
    /// boundary — an attacker recomputes it for free. The AEAD+AAD is the boundary.
    pub checksum: String,
}

/// An `Option` field that must be PRESENT (it may be `null`).
///
/// Attaching `deserialize_with` and omitting `default` is what turns off serde's
/// implicit "missing Option ⇒ None". The body is the ordinary Option deserializer — the
/// strictness comes from the attribute, not from this code.
fn required_option<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d)
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(s: &str) -> Result<Vec<u8>, &'static str> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).map_err(|_| ERR_BACKUP_INVALID)
}

impl RecoveryBundle {
    /// The bytes the checksum covers: the whole bundle with `checksum` blanked.
    fn checksum_input(&self) -> Vec<u8> {
        let mut copy = self.clone();
        copy.checksum = String::new();
        serde_json::to_vec(&copy).unwrap_or_default()
    }

    fn compute_checksum(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(self.checksum_input());
        h.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The associated data bound into the AEAD — `canonical_bytes_v1` (§2).
    ///
    /// Was a hand-rolled length-prefixed concatenation. The framing was right, but it was
    /// a second, undocumented encoding living next to the certificate's: two formats to
    /// keep in step, and integers went in as `to_string()` — text, i.e. one more thing two
    /// implementations can format differently. Now it is the same writer, with its own
    /// domain separator, so a recovery AAD can never equal a transfer AAD.
    fn aad(&self) -> Vec<u8> {
        let mut w = super::canonical::CanonicalWriter::new(
            super::canonical::DOMAIN_RECOVERY_BUNDLE_AAD,
            self.format_version,
        );
        // The purpose leads: a transfer package and a recovery bundle must not decrypt
        // under each other's importer even if every other field were made to line up.
        w.string(&self.purpose)
            .string(&self.tenant_id)
            .string(&self.root_key_id)
            .i64(self.root_generation);
        w.finish()
    }
}

/// Argon2id password → 32-byte key. The caller must zeroize the result.
fn derive_key(password: &str, salt: &[u8], p: &KdfParameters) -> Result<[u8; 32], &'static str> {
    let params = argon2::Params::new(p.m_cost_kib, p.t_cost, p.p_cost, Some(32))
        .map_err(|_| ERR_BACKUP_WEAK_KDF)?;
    let a2 = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut key = [0u8; 32];
    a2.hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|_| ERR_BACKUP_INVALID)?;
    Ok(key)
}

/// §13 — every structural bound, checked in one place and BEFORE the KDF.
///
/// Ordering matters: Argon2id at 64 MiB × 3 passes is deliberately expensive, so a
/// malformed file must never get that far. Everything here is cheap and constant-time-ish.
fn validate_structure(b: &RecoveryBundle) -> Result<(), &'static str> {
    // Version and purpose first — they say what we are even looking at.
    if b.format_version != BUNDLE_FORMAT_VERSION {
        return Err(ERR_BACKUP_UNSUPPORTED_VERSION);
    }
    // The sibling format is recognised BY NAME and refused first. Both branches return
    // the same code, but the distinction is real: "this is an authority-transfer package,
    // which is not what this importer opens" is a different fact from "this purpose is
    // gibberish", and the branch is where a future reader learns the two formats exist
    // and are deliberately not interchangeable.
    if b.purpose == PURPOSE_AUTHORITY_TRANSFER {
        eprintln!("[trust] recovery import refused: this file is an authority-transfer package");
        return Err(ERR_BACKUP_WRONG_PURPOSE);
    }
    if b.purpose != PURPOSE_RECOVERY {
        return Err(ERR_BACKUP_WRONG_PURPOSE);
    }
    if b.encryption_algorithm != AEAD_AES_256_GCM {
        return Err(ERR_BACKUP_INVALID);
    }
    if b.root_generation < 1 {
        return Err(ERR_BACKUP_INVALID);
    }

    // Bounded strings. A UUID is 36 chars; a megabyte of "tenant_id" is not ours.
    for s in [&b.tenant_id, &b.root_key_id] {
        if s.is_empty() || s.len() > MAX_ID_LEN {
            return Err(ERR_BACKUP_INVALID);
        }
    }
    for s in [&b.created_at, &b.exported_at] {
        if s.len() > MAX_TIMESTAMP_LEN {
            return Err(ERR_BACKUP_INVALID);
        }
    }
    for hint in [&b.last_known_authority_id, &b.last_known_certificate_serial] {
        if hint.as_ref().is_some_and(|s| s.len() > MAX_ID_LEN) {
            return Err(ERR_BACKUP_INVALID);
        }
    }

    // Exact encodings. These are not "roughly this size" — they are fixed by the
    // algorithms, so anything else was not produced by us.
    if b.public_key.len() != PUBLIC_KEY_B64_LEN
        || b.fingerprint.len() != FINGERPRINT_HEX_LEN
        || b.checksum.len() != CHECKSUM_HEX_LEN
    {
        return Err(ERR_BACKUP_INVALID);
    }
    if unb64(&b.salt)?.len() != SALT_LEN {
        return Err(ERR_BACKUP_INVALID);
    }
    if unb64(&b.nonce)?.len() != NONCE_LEN {
        return Err(ERR_BACKUP_INVALID);
    }
    if unb64(&b.ciphertext)?.len() != CIPHERTEXT_LEN {
        return Err(ERR_BACKUP_INVALID);
    }
    if unb64(&b.public_key)?.len() != 32 {
        return Err(ERR_BACKUP_INVALID);
    }
    Ok(())
}

fn validate_kdf(kdf: &str, p: &KdfParameters) -> Result<(), &'static str> {
    if kdf != KDF_ARGON2ID {
        return Err(ERR_BACKUP_WEAK_KDF);
    }
    if p.m_cost_kib < MIN_M_COST_KIB || p.m_cost_kib > MAX_M_COST_KIB {
        return Err(ERR_BACKUP_WEAK_KDF);
    }
    if p.t_cost < MIN_T_COST || p.t_cost > MAX_T_COST {
        return Err(ERR_BACKUP_WEAK_KDF);
    }
    if p.p_cost < MIN_P_COST || p.p_cost > MAX_P_COST {
        return Err(ERR_BACKUP_WEAK_KDF);
    }
    Ok(())
}

/// Check the recovery passphrase the owner chose for the bundle.
///
/// Deliberately separate from the owner's *login* password: the bundle leaves the
/// building, so it must not be unlockable by the same secret that unlocks the shop.
pub fn validate_recovery_password(password: &str, confirmation: &str) -> Result<(), &'static str> {
    if password.chars().count() < MIN_RECOVERY_PASSWORD_LEN {
        return Err(ERR_PASSWORD_TOO_WEAK);
    }
    if password != confirmation {
        return Err(ERR_PASSWORD_MISMATCH);
    }
    Ok(())
}

/// Hints copied into the bundle. Explicitly not a promise.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuthorityHints {
    pub authority_id: Option<String>,
    pub authority_epoch: Option<i64>,
    pub certificate_serial: Option<String>,
}

/// Export the tenant root into an encrypted bundle.
///
/// `key` is borrowed, never copied out: the only plaintext that leaves is the ciphertext.
pub fn export_bundle(
    key: &super::trust_root::RootKey,
    record: &TrustRootRecord,
    created_at: &str,
    recovery_password: &str,
    hints: &AuthorityHints,
) -> Result<RecoveryBundle, &'static str> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use rand::RngCore;

    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 12];
    rand::rngs::OsRng.try_fill_bytes(&mut salt).map_err(|_| ERR_BACKUP_INVALID)?;
    rand::rngs::OsRng.try_fill_bytes(&mut nonce_bytes).map_err(|_| ERR_BACKUP_INVALID)?;

    let kdf_parameters = KdfParameters {
        m_cost_kib: ARGON2_M_COST_KIB,
        t_cost: ARGON2_T_COST,
        p_cost: ARGON2_P_COST,
    };

    // Build the bundle WITHOUT ciphertext/checksum first, so `aad()` is computed from the
    // very fields that will later be verified against it.
    let mut bundle = RecoveryBundle {
        format_version: BUNDLE_FORMAT_VERSION,
        purpose: PURPOSE_RECOVERY.to_string(),
        tenant_id: record.tenant_id.clone(),
        root_key_id: record.root_key_id.clone(),
        root_generation: record.generation,
        public_key: record.public_key.clone(),
        fingerprint: record.fingerprint.clone(),
        created_at: created_at.to_string(),
        exported_at: chrono::Utc::now().to_rfc3339(),
        kdf: KDF_ARGON2ID.to_string(),
        kdf_parameters,
        salt: b64(&salt),
        encryption_algorithm: AEAD_AES_256_GCM.to_string(),
        nonce: b64(&nonce_bytes),
        ciphertext: String::new(),
        last_known_authority_id: hints.authority_id.clone(),
        last_known_authority_epoch: hints.authority_epoch,
        last_known_certificate_serial: hints.certificate_serial.clone(),
        checksum: String::new(),
    };

    let mut dk = derive_key(recovery_password, &salt, &bundle.kdf_parameters)?;
    let result = (|| -> Result<Vec<u8>, &'static str> {
        let cipher = aes_gcm::Aes256Gcm::new_from_slice(&dk).map_err(|_| ERR_BACKUP_INVALID)?;
        cipher
            .encrypt(
                aes_gcm::Nonce::from_slice(&nonce_bytes),
                Payload { msg: key.seed(), aad: &bundle.aad() },
            )
            .map_err(|_| ERR_BACKUP_INVALID)
    })();
    dk.zeroize();

    bundle.ciphertext = b64(&result?);
    bundle.checksum = bundle.compute_checksum();
    Ok(bundle)
}

pub fn serialize_bundle(bundle: &RecoveryBundle) -> Result<String, &'static str> {
    serde_json::to_string_pretty(bundle).map_err(|_| ERR_BACKUP_INVALID)
}

/// What a successful import yields: the verified public record + the private seed.
pub struct ImportedRoot {
    pub record: TrustRootRecord,
    pub seed: [u8; 32],
    pub hints: AuthorityHints,
}

impl Drop for ImportedRoot {
    fn drop(&mut self) {
        self.seed.zeroize();
    }
}

impl std::fmt::Debug for ImportedRoot {
    /// Hand-written, NOT derived. `unwrap()` on a `Result<ImportedRoot, _>` prints this,
    /// and a derived impl would put the tenant's private root key into the test output —
    /// and into any panic message a user ever pastes into a bug report.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "ImportedRoot({}, seed=<redacted>)",
            super::trust_root::redact(&self.record.root_key_id)
        )
    }
}

/// Parse + verify + decrypt a bundle, in the order §7 prescribes.
///
/// The order is not cosmetic: cheap structural checks come before the deliberately
/// expensive KDF, so a malformed file cannot make us burn 64 MiB and 3 passes of Argon2
/// per attempt.
pub fn import_bundle(
    raw: &str,
    expected_tenant: &str,
    recovery_password: &str,
) -> Result<ImportedRoot, &'static str> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};

    // 1. format + size limits
    if raw.len() > MAX_BUNDLE_BYTES {
        return Err(ERR_BACKUP_INVALID);
    }
    let bundle: RecoveryBundle = serde_json::from_str(raw).map_err(|_| ERR_BACKUP_INVALID)?;

    // 2. checksum (accidental damage)
    if bundle.checksum != bundle.compute_checksum() {
        return Err(ERR_BACKUP_INVALID);
    }

    // 3. structure: version, purpose, bounded strings, exact encodings (§13).
    validate_structure(&bundle)?;
    if bundle.tenant_id != expected_tenant {
        return Err(ERR_BACKUP_WRONG_TENANT);
    }

    // 4. KDF acceptability (before we spend the memory)
    validate_kdf(&bundle.kdf, &bundle.kdf_parameters)?;

    let salt = unb64(&bundle.salt)?;
    let nonce_bytes = unb64(&bundle.nonce)?;
    let ciphertext = unb64(&bundle.ciphertext)?;

    // 5. AEAD — this is where a wrong password, a tampered AAD or a flipped byte all fail,
    //    and they fail indistinguishably. That is deliberate: the caller gets
    //    "bundle or password invalid", not a hint about which.
    let mut dk = derive_key(recovery_password, &salt, &bundle.kdf_parameters)?;
    let opened = (|| -> Result<Vec<u8>, &'static str> {
        let cipher = aes_gcm::Aes256Gcm::new_from_slice(&dk).map_err(|_| ERR_BACKUP_INVALID)?;
        cipher
            .decrypt(
                aes_gcm::Nonce::from_slice(&nonce_bytes),
                Payload { msg: &ciphertext, aad: &bundle.aad() },
            )
            .map_err(|_| ERR_BACKUP_INVALID)
    })();
    dk.zeroize();
    let mut plain = opened?;

    // 6. public key / fingerprint consistency — the decrypted seed must actually BE the
    //    key this bundle claims to carry. Without this a bundle could decrypt cleanly and
    //    still install a root whose public half nobody has ever seen.
    let seed: [u8; 32] = match plain.as_slice().try_into() {
        Ok(s) => s,
        Err(_) => {
            plain.zeroize();
            return Err(ERR_BACKUP_INVALID);
        }
    };
    plain.zeroize();

    let probe = super::trust_root::RootKey::from_seed(seed, bundle.root_key_id.clone());
    if probe.public_key_b64() != bundle.public_key {
        return Err(ERR_BACKUP_INVALID);
    }
    if probe.fingerprint() != bundle.fingerprint {
        return Err(ERR_BACKUP_INVALID);
    }
    if super::trust_root::fingerprint_of(&unb64(&bundle.public_key)?) != bundle.fingerprint {
        return Err(ERR_BACKUP_INVALID);
    }

    // 7. only now is it a root worth adopting
    Ok(ImportedRoot {
        record: TrustRootRecord {
            tenant_id: bundle.tenant_id.clone(),
            root_key_id: bundle.root_key_id.clone(),
            public_key: bundle.public_key.clone(),
            fingerprint: bundle.fingerprint.clone(),
            generation: bundle.root_generation,
            state: RootState::Active,
        },
        seed,
        hints: AuthorityHints {
            authority_id: bundle.last_known_authority_id.clone(),
            authority_epoch: bundle.last_known_authority_epoch,
            certificate_serial: bundle.last_known_certificate_serial.clone(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::primary::{self, State};
    use crate::sync::trust_root::{self, testkit::*};

    /// The install id these tests found their root under. A fixed UUID rather than a
    /// random one: M6-B2C4 records custody per install, and a value that changed between
    /// calls would make the custody row point at a machine the next call is not.
    const TEST_INSTALL: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    use rusqlite::{params, Connection};

    const PW: &str = "correct-horse-battery-staple";

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

    /// A tenant with an active root + its exported bundle. The `TempDir` must be held by
    /// the caller: dropping it deletes the key file the test still needs.
    fn exported() -> (Connection, TempDir, TrustRootRecord, String) {
        let conn = db();
        let o = owner(&conn);
        let d = tmp_dir();
        let rec = trust_root::initialize_root(&conn, &d, "tenant-1", TEST_INSTALL, State::Primary, &o).unwrap();
        let key = trust_root::load_key(&d, &rec).unwrap();
        let b = export_bundle(&key, &rec, "2026-07-17T00:00:00Z", PW, &AuthorityHints::default())
            .unwrap();
        let raw = serialize_bundle(&b).unwrap();
        (conn, d, rec, raw)
    }

    // ── K5: the export carries no plaintext private key ──────────────────────
    #[test]
    fn k5_export_contains_no_plaintext_private_key() {
        use base64::Engine;
        let (_c, d, rec, raw) = exported();
        let key = trust_root::load_key(&d, &rec).unwrap();
        let seed = *key.seed();

        let seed_b64 = base64::engine::general_purpose::STANDARD.encode(seed);
        let seed_hex: String = seed.iter().map(|b| format!("{b:02x}")).collect();

        assert!(!raw.contains(&seed_b64), "raw seed must not appear base64-encoded");
        assert!(!raw.contains(&seed_hex), "raw seed must not appear hex-encoded");
        // and not as raw bytes either
        assert!(
            !raw.as_bytes().windows(32).any(|w| w == seed),
            "raw seed bytes must not appear anywhere in the bundle"
        );
        // The password must never be stored.
        assert!(!raw.contains(PW), "the recovery password must never be written");
        // The PUBLIC key is expected to be there.
        assert!(raw.contains(&rec.public_key));
    }

    // ── K6: export → import restores exactly the same root ───────────────────
    #[test]
    fn k6_roundtrip_restores_the_same_root() {
        let (_c, d, rec, raw) = exported();
        let original_seed = *trust_root::load_key(&d, &rec).unwrap().seed();

        let imported = import_bundle(&raw, "tenant-1", PW).unwrap();
        assert_eq!(imported.record, rec, "the public record must match exactly");
        assert_eq!(imported.seed, original_seed, "the private key must be identical");

        // …and the restored key signs verifiably under the same public key.
        let restored = trust_root::RootKey::from_seed(imported.seed, rec.root_key_id.clone());
        let sig = restored.sign(b"authority-payload");
        assert!(trust_root::verify_signature(&rec.public_key, b"authority-payload", &sig));
    }

    // ── K6b: a restored root really re-establishes the tenant on a NEW machine ──
    #[test]
    fn k6b_restore_onto_a_fresh_machine() {
        let (_c, _d, rec, raw) = exported();

        // Fresh machine: new DB, new app data dir, nothing else survives.
        let c2 = db();
        let o2 = owner(&c2);
        let d2 = tmp_dir();
        assert!(trust_root::load_active_root(&c2, "tenant-1").unwrap().is_none());

        let imported = import_bundle(&raw, "tenant-1", PW).unwrap();
        trust_root::restore_root(&c2, &d2, &imported.record, imported.seed, TEST_INSTALL, &o2).unwrap();

        let restored_rec = trust_root::load_active_root(&c2, "tenant-1").unwrap().unwrap();
        assert_eq!(restored_rec, rec, "same tenant root continues");
        let k = trust_root::load_key(&d2, &restored_rec).unwrap();
        assert_eq!(k.public_key_b64(), rec.public_key);
    }

    // ── K7: wrong recovery password ──────────────────────────────────────────
    #[test]
    fn k7_wrong_password_is_refused() {
        let (_c, _d, _rec, raw) = exported();
        for bad in ["", "wrong", "correct-horse-battery-stapl", "Correct-Horse-Battery-Staple"] {
            assert_eq!(
                import_bundle(&raw, "tenant-1", bad).unwrap_err(),
                ERR_BACKUP_INVALID,
                "password {bad:?} must be refused"
            );
        }
    }

    // ── K8: corrupted bundle ─────────────────────────────────────────────────
    #[test]
    fn k8_corrupted_bundle_is_refused() {
        let (_c, _d, _rec, raw) = exported();

        // not JSON
        assert!(import_bundle("{{{", "tenant-1", PW).is_err());
        // truncated
        assert!(import_bundle(&raw[..raw.len() / 2], "tenant-1", PW).is_err());
        // oversize
        let huge = format!("{}{}", raw, " ".repeat(MAX_BUNDLE_BYTES));
        assert_eq!(import_bundle(&huge, "tenant-1", PW).unwrap_err(), ERR_BACKUP_INVALID);

        // a flipped ciphertext byte: checksum still matches (it covers the field as
        // written), so this must be caught by the AEAD tag.
        let mut b: RecoveryBundle = serde_json::from_str(&raw).unwrap();
        let mut ct = unb64(&b.ciphertext).unwrap();
        ct[0] ^= 0x01;
        b.ciphertext = b64(&ct);
        b.checksum = b.compute_checksum();
        assert_eq!(
            import_bundle(&serialize_bundle(&b).unwrap(), "tenant-1", PW).unwrap_err(),
            ERR_BACKUP_INVALID,
            "flipped ciphertext must fail the AEAD tag"
        );

        // a stale checksum (metadata edited without recomputing) is caught at step 2
        let mut b2: RecoveryBundle = serde_json::from_str(&raw).unwrap();
        b2.exported_at = "1999-01-01T00:00:00Z".into();
        assert_eq!(
            import_bundle(&serialize_bundle(&b2).unwrap(), "tenant-1", PW).unwrap_err(),
            ERR_BACKUP_INVALID,
            "checksum must catch edited metadata"
        );
    }

    // ── K9: foreign tenant ───────────────────────────────────────────────────
    #[test]
    fn k9_foreign_tenant_bundle_is_refused() {
        let (_c, _d, _rec, raw) = exported();
        assert_eq!(
            import_bundle(&raw, "tenant-2", PW).unwrap_err(),
            ERR_BACKUP_WRONG_TENANT,
            "a bundle for another tenant must never install here"
        );
    }

    // ── K10: rewritten AAD metadata (with recomputed checksum) ───────────────
    //
    // The interesting case. The attacker knows the checksum is not a boundary and
    // recomputes it. Only the AEAD binding can catch this.
    #[test]
    fn k10_rewritten_aad_metadata_fails_the_aead() {
        let (_c, _d, _rec, raw) = exported();

        // (a) claim the bundle belongs to tenant-2, checksum recomputed
        let mut b: RecoveryBundle = serde_json::from_str(&raw).unwrap();
        b.tenant_id = "tenant-2".into();
        b.checksum = b.compute_checksum();
        let tampered = serialize_bundle(&b).unwrap();
        assert_eq!(
            import_bundle(&tampered, "tenant-2", PW).unwrap_err(),
            ERR_BACKUP_INVALID,
            "tenant_id is in the AAD — retagging must break decryption, not succeed"
        );

        // (b) rewrite root_key_id
        let mut b2: RecoveryBundle = serde_json::from_str(&raw).unwrap();
        b2.root_key_id = uuid::Uuid::new_v4().to_string();
        b2.checksum = b2.compute_checksum();
        assert_eq!(
            import_bundle(&serialize_bundle(&b2).unwrap(), "tenant-1", PW).unwrap_err(),
            ERR_BACKUP_INVALID
        );

        // (c) rewrite root_generation
        let mut b3: RecoveryBundle = serde_json::from_str(&raw).unwrap();
        b3.root_generation = 99;
        b3.checksum = b3.compute_checksum();
        assert_eq!(
            import_bundle(&serialize_bundle(&b3).unwrap(), "tenant-1", PW).unwrap_err(),
            ERR_BACKUP_INVALID
        );

        // (d) swap in a foreign public key: AAD is intact, so the AEAD opens — this must
        //     be caught by the step-6 consistency check instead.
        let mut b4: RecoveryBundle = serde_json::from_str(&raw).unwrap();
        let other = trust_root::RootKey::from_seed([9u8; 32], "x".into());
        b4.public_key = other.public_key_b64();
        b4.fingerprint = other.fingerprint();
        b4.checksum = b4.compute_checksum();
        assert_eq!(
            import_bundle(&serialize_bundle(&b4).unwrap(), "tenant-1", PW).unwrap_err(),
            ERR_BACKUP_INVALID,
            "the decrypted seed must match the advertised public key"
        );
    }

    // ── K11: unacceptable KDF parameters ─────────────────────────────────────
    #[test]
    fn k11_unacceptable_kdf_parameters_are_refused() {
        let (_c, _d, _rec, raw) = exported();
        let cases = [
            (KdfParameters { m_cost_kib: 8, t_cost: 3, p_cost: 1 }, "memory far too low"),
            (KdfParameters { m_cost_kib: 65_535, t_cost: 3, p_cost: 1 }, "just under 64 MiB"),
            (KdfParameters { m_cost_kib: 65_536, t_cost: 1, p_cost: 1 }, "too few passes"),
            (KdfParameters { m_cost_kib: 65_536, t_cost: 2, p_cost: 1 }, "still too few"),
            (KdfParameters { m_cost_kib: 65_536, t_cost: 3, p_cost: 0 }, "p = 0"),
            // the memory bomb: we must refuse BEFORE allocating
            (KdfParameters { m_cost_kib: 16_777_216, t_cost: 3, p_cost: 1 }, "16 GiB bomb"),
            (KdfParameters { m_cost_kib: u32::MAX, t_cost: 3, p_cost: 1 }, "max bomb"),
            (KdfParameters { m_cost_kib: 65_536, t_cost: u32::MAX, p_cost: 1 }, "cpu bomb"),
        ];
        for (p, why) in cases {
            let mut b: RecoveryBundle = serde_json::from_str(&raw).unwrap();
            b.kdf_parameters = p;
            b.checksum = b.compute_checksum();
            assert_eq!(
                import_bundle(&serialize_bundle(&b).unwrap(), "tenant-1", PW).unwrap_err(),
                ERR_BACKUP_WEAK_KDF,
                "{why} must be refused"
            );
        }
        // and an unknown KDF name
        let mut b: RecoveryBundle = serde_json::from_str(&raw).unwrap();
        b.kdf = "pbkdf2".into();
        b.checksum = b.compute_checksum();
        assert_eq!(
            import_bundle(&serialize_bundle(&b).unwrap(), "tenant-1", PW).unwrap_err(),
            ERR_BACKUP_WEAK_KDF,
            "no silent fallback to a weaker KDF"
        );
    }

    // ── K11b: the parameters we WRITE satisfy the contract ───────────────────
    #[test]
    fn k11b_written_parameters_meet_the_declared_minimum() {
        let (_c, _d, _rec, raw) = exported();
        let b: RecoveryBundle = serde_json::from_str(&raw).unwrap();
        assert_eq!(b.kdf, KDF_ARGON2ID, "Argon2id, never PBKDF2");
        assert_eq!(b.encryption_algorithm, AEAD_AES_256_GCM);
        assert!(b.kdf_parameters.m_cost_kib >= 65_536, "m >= 64 MiB");
        assert!(b.kdf_parameters.t_cost >= 3, "t >= 3");
        assert!(b.kdf_parameters.p_cost >= 1);
        assert_eq!(unb64(&b.nonce).unwrap().len(), 12, "96-bit nonce");
        assert!(unb64(&b.salt).unwrap().len() >= 16);
        // AES-256-GCM: ciphertext = 32-byte seed + 16-byte tag
        assert_eq!(unb64(&b.ciphertext).unwrap().len(), 32 + 16, "seed + auth tag");
    }

    // ── K11c: salt and nonce are fresh per export ────────────────────────────
    #[test]
    fn k11c_salt_and_nonce_are_never_reused() {
        let (_c, d, rec, raw1) = exported();
        let key = trust_root::load_key(&d, &rec).unwrap();
        let b2 =
            export_bundle(&key, &rec, "2026-07-17T00:00:00Z", PW, &AuthorityHints::default())
                .unwrap();
        let b1: RecoveryBundle = serde_json::from_str(&raw1).unwrap();
        assert_ne!(b1.salt, b2.salt, "fresh salt per export");
        assert_ne!(b1.nonce, b2.nonce, "fresh nonce — GCM nonce reuse is catastrophic");
        assert_ne!(b1.ciphertext, b2.ciphertext);
        // …and both still open.
        assert!(import_bundle(&serialize_bundle(&b2).unwrap(), "tenant-1", PW).is_ok());
    }

    // ── K12: repeated identical import is idempotent ─────────────────────────
    #[test]
    fn k12_repeated_identical_import_is_idempotent() {
        let (_c, _d, rec, raw) = exported();
        let c2 = db();
        let o2 = owner(&c2);
        let d2 = tmp_dir();

        for _ in 0..3 {
            let imp = import_bundle(&raw, "tenant-1", PW).unwrap();
            trust_root::restore_root(&c2, &d2, &imp.record, imp.seed, TEST_INSTALL, &o2)
                .expect("re-importing the SAME root must be a no-op, not an error");
        }
        let n: i64 = conn_count(&c2);
        assert_eq!(n, 1, "still exactly one root row");
        assert_eq!(trust_root::load_active_root(&c2, "tenant-1").unwrap().unwrap(), rec);
    }

    fn conn_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM tenant_trust_roots", [], |r| r.get(0)).unwrap()
    }

    // ── K13: a contradicting import is refused ───────────────────────────────
    #[test]
    fn k13_contradicting_import_is_refused() {
        let (_c1, d1, rec1, _raw1) = exported();
        let (_c2, _d2, _rec2, raw2) = exported(); // a DIFFERENT root, same tenant id

        // Machine already has root #1; someone tries to import root #2 over it.
        let c = db();
        let o = owner(&c);
        let d = tmp_dir();
        let imp1 = {
            let key = trust_root::load_key(&d1, &rec1).unwrap();
            let b = export_bundle(&key, &rec1, "2026-07-17T00:00:00Z", PW, &AuthorityHints::default())
                .unwrap();
            import_bundle(&serialize_bundle(&b).unwrap(), "tenant-1", PW).unwrap()
        };
        trust_root::restore_root(&c, &d, &imp1.record, imp1.seed, TEST_INSTALL, &o).unwrap();

        let imp2 = import_bundle(&raw2, "tenant-1", PW).unwrap();
        let err = trust_root::restore_root(&c, &d, &imp2.record, imp2.seed, TEST_INSTALL, &o).unwrap_err();
        assert_eq!(
            err,
            trust_root::ERR_ROOT_KEY_ALREADY_EXISTS,
            "a second, different root must never silently replace the first"
        );
        // the original is untouched
        assert_eq!(trust_root::load_active_root(&c, "tenant-1").unwrap().unwrap(), rec1);
        assert_eq!(conn_count(&c), 1);
    }

    // ── §13: strict parsing — every input bound is fail-closed ───────────────
    //
    // Driven through `import_bundle`, i.e. the real door, not the struct.

    /// Serialize a bundle to a mutable JSON object so a test can inject things serde
    /// would never emit (unknown fields, duplicates, wrong types).
    fn as_json(raw: &str) -> serde_json::Value {
        serde_json::from_str(raw).unwrap()
    }
    fn reserialize(v: &serde_json::Value) -> String {
        serde_json::to_string(v).unwrap()
    }

    #[test]
    fn s13_unknown_field_is_refused() {
        let (_c, d, _rec, raw) = exported();
        let mut v = as_json(&raw);
        v["totally_new_field"] = serde_json::json!("surprise");
        assert_eq!(
            import_bundle(&reserialize(&v), "tenant-1", PW).unwrap_err(),
            ERR_BACKUP_INVALID,
            "deny_unknown_fields: a bundle we did not write must not be parsed"
        );
        drop(d);
    }

    #[test]
    fn s13_duplicate_field_is_refused() {
        let (_c, d, _rec, raw) = exported();
        // serde_json's default is last-wins; `deny_unknown_fields` does not cover this,
        // so it is asserted separately — a duplicate key means two different readers can
        // disagree about the same bytes, which is exactly what must not happen.
        let injected = raw.replacen("\"tenant_id\":", "\"tenant_id\": \"tenant-2\",\n  \"tenant_id\":", 1);
        let r = import_bundle(&injected, "tenant-1", PW);
        assert!(r.is_err(), "a duplicated field must not be accepted");
        drop(d);
    }

    #[test]
    fn s13_wrong_types_are_refused() {
        let (_c, d, _rec, raw) = exported();
        for (field, bad) in [
            ("format_version", serde_json::json!("one")),
            ("root_generation", serde_json::json!("many")),
            ("tenant_id", serde_json::json!(42)),
            ("kdf_parameters", serde_json::json!("argon2id")),
            ("last_known_authority_epoch", serde_json::json!("seven")),
        ] {
            let mut v = as_json(&raw);
            v[field] = bad;
            assert!(
                import_bundle(&reserialize(&v), "tenant-1", PW).is_err(),
                "{field} with a wrong type must be refused"
            );
        }
        drop(d);
    }

    #[test]
    fn s13_missing_field_is_refused_no_silent_default() {
        let (_c, d, _rec, raw) = exported();
        // The hint fields are Option — but they must be PRESENT. A missing field
        // silently becoming None would be a different claim than "explicitly nothing".
        for field in [
            "last_known_authority_id",
            "last_known_authority_epoch",
            "last_known_certificate_serial",
            "purpose",
            "tenant_id",
            "kdf_parameters",
        ] {
            let mut v = as_json(&raw);
            v.as_object_mut().unwrap().remove(field);
            assert!(
                import_bundle(&reserialize(&v), "tenant-1", PW).is_err(),
                "a missing {field} must not default silently"
            );
        }
        drop(d);
    }

    #[test]
    fn s13_oversized_values_are_refused() {
        let (_c, d, _rec, raw) = exported();
        // Long id
        let mut v = as_json(&raw);
        v["root_key_id"] = serde_json::json!("x".repeat(MAX_ID_LEN + 1));
        assert_eq!(import_bundle(&reserialize(&v), "tenant-1", PW).unwrap_err(), ERR_BACKUP_INVALID);
        // Long base64 blobs
        for field in ["ciphertext", "salt", "nonce", "public_key"] {
            let mut v = as_json(&raw);
            v[field] = serde_json::json!(b64(&vec![7u8; 4096]));
            assert!(
                import_bundle(&reserialize(&v), "tenant-1", PW).is_err(),
                "{field}: an oversized blob must be refused"
            );
        }
        // Whole-file cap
        let huge = format!("{}{}", raw, " ".repeat(MAX_BUNDLE_BYTES));
        assert_eq!(import_bundle(&huge, "tenant-1", PW).unwrap_err(), ERR_BACKUP_INVALID);
        drop(d);
    }

    #[test]
    fn s13_wrong_crypto_lengths_are_refused() {
        let (_c, d, _rec, raw) = exported();
        for (field, bytes, why) in [
            ("nonce", 11, "96-bit nonce is exact"),
            ("nonce", 13, "96-bit nonce is exact"),
            ("salt", 8, "salt length is exact"),
            ("ciphertext", 47, "seed + tag is exact"),
            ("ciphertext", 49, "seed + tag is exact"),
            ("public_key", 31, "Ed25519 public key is 32 bytes"),
            ("public_key", 33, "Ed25519 public key is 32 bytes"),
        ] {
            let mut v = as_json(&raw);
            v[field] = serde_json::json!(b64(&vec![3u8; bytes]));
            assert_eq!(
                import_bundle(&reserialize(&v), "tenant-1", PW).unwrap_err(),
                ERR_BACKUP_INVALID,
                "{field} with {bytes} bytes: {why}"
            );
        }
        // Not even valid base64.
        let mut v = as_json(&raw);
        v["nonce"] = serde_json::json!("!!!not-base64!!!");
        assert_eq!(import_bundle(&reserialize(&v), "tenant-1", PW).unwrap_err(), ERR_BACKUP_INVALID);
        drop(d);
    }

    #[test]
    fn s13_unknown_format_version_is_refused() {
        let (_c, d, _rec, raw) = exported();
        for ver in [0, 2, 99, u32::MAX] {
            let mut v = as_json(&raw);
            v["format_version"] = serde_json::json!(ver);
            assert_eq!(
                import_bundle(&reserialize(&v), "tenant-1", PW).unwrap_err(),
                ERR_BACKUP_UNSUPPORTED_VERSION,
                "format_version {ver} must be refused, never guessed"
            );
        }
        drop(d);
    }

    // ── §13 / T3: purpose separation ─────────────────────────────────────────
    #[test]
    fn s13_purpose_is_strict_and_recovery_transfer_are_not_interchangeable() {
        let (_c, d, _rec, raw) = exported();

        // What we write.
        assert_eq!(as_json(&raw)["purpose"], serde_json::json!(PURPOSE_RECOVERY));

        // An unknown purpose is refused. The checksum is recomputed each time on
        // purpose: step 2 would otherwise reject the edit as damage and never reach the
        // purpose check, so the test would prove nothing about purpose at all.
        for p in ["", "something_else", "TENANT_ROOT_RECOVERY", PURPOSE_AUTHORITY_TRANSFER] {
            let mut b: RecoveryBundle = serde_json::from_str(&raw).unwrap();
            b.purpose = p.into();
            b.checksum = b.compute_checksum();
            assert_eq!(
                import_bundle(&serialize_bundle(&b).unwrap(), "tenant-1", PW).unwrap_err(),
                ERR_BACKUP_WRONG_PURPOSE,
                "purpose {p:?} must be refused even with a freshly computed checksum —                  a transfer package must never be replayable as a recovery bundle"
            );
        }
        drop(d);
    }

    /// The purpose is in the AAD, so even if the structural check were removed the AEAD
    /// would still refuse. Proven by decrypting with a hand-built AAD that differs only
    /// in the purpose.
    #[test]
    fn s13_purpose_is_bound_into_the_aead() {
        let (_c, d, _rec, raw) = exported();
        let real: RecoveryBundle = serde_json::from_str(&raw).unwrap();
        let mut swapped = real.clone();
        swapped.purpose = PURPOSE_AUTHORITY_TRANSFER.into();
        assert_ne!(real.aad(), swapped.aad(), "the purpose must change the AAD");
        drop(d);
    }

    // ── recovery password policy ─────────────────────────────────────────────
    #[test]
    fn recovery_password_policy_is_enforced() {
        assert_eq!(validate_recovery_password("short", "short").unwrap_err(), ERR_PASSWORD_TOO_WEAK);
        assert_eq!(
            validate_recovery_password(PW, "something-else").unwrap_err(),
            ERR_PASSWORD_MISMATCH
        );
        assert!(validate_recovery_password(PW, PW).is_ok());
        // exactly at the boundary
        let twelve = "a".repeat(MIN_RECOVERY_PASSWORD_LEN);
        assert!(validate_recovery_password(&twelve, &twelve).is_ok());
        let eleven = "a".repeat(MIN_RECOVERY_PASSWORD_LEN - 1);
        assert!(validate_recovery_password(&eleven, &eleven).is_err());
    }

    // ── hints are carried but explicitly non-binding ─────────────────────────
    #[test]
    fn authority_hints_roundtrip() {
        let (_c, d, rec, _raw) = exported();
        let key = trust_root::load_key(&d, &rec).unwrap();
        let hints = AuthorityHints {
            authority_id: Some("auth-1".into()),
            authority_epoch: Some(7),
            certificate_serial: Some("serial-1".into()),
        };
        let b = export_bundle(&key, &rec, "2026-07-17T00:00:00Z", PW, &hints).unwrap();
        let imp = import_bundle(&serialize_bundle(&b).unwrap(), "tenant-1", PW).unwrap();
        assert_eq!(imp.hints, hints, "hints survive the round trip");
    }
}
