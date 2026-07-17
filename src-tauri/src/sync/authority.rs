//! M6-B2C — authority certificates and host transfer. **INACTIVE.**
//!
//! ## What a certificate is
//!
//! A statement, signed by the tenant root (M6-B2B): *"installation X is the authority for
//! tenant/branch at epoch N"*. M6-B2A's binding convinces one machine (its own DB says
//! so); a certificate can be checked by anyone holding the tenant's public root key.
//!
//! ## What it is NOT — stated up front, because the temptation is real
//!
//! A certificate does **not** prevent split-brain. M6-A4 §1 settled this: without a
//! shared lease or consensus, mutual exclusion is not enforceable, and nothing in this
//! module changes that. Two partitioned machines can each hold a certificate that
//! verifies perfectly. What certificates buy is *attributable, ordered, checkable*
//! claims — so a conflict becomes **detectable** (`AUTHORITY_PARTITION_UNRESOLVED`)
//! instead of silent. Detection is not prevention, and this module never pretends
//! otherwise.
//!
//! ## Deliberately inactive
//!
//! Nothing here is consulted by `/sync/push`. The B2A write gate (`may_write_sync()`) is
//! untouched. Issuing and verifying certificates must be provably harmless before they
//! are allowed to refuse anyone's data — activation is a later, explicit slice.
//!
//! ## No expiry
//!
//! The shop must keep working offline, so a certificate never ends by a clock. It ends by
//! being superseded (a transfer) or revoked (an owner decision).

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::primary::OwnerAuth;
use super::trust_root::{self, RootKey, TrustRootRecord};

pub const CERTIFICATE_VERSION: u32 = 1;

// ── §13 — hard structural limits on everything an attacker hands us.
/// A certificate is ~600 bytes. A megabyte of "certificate" is not ours.
pub const MAX_CERTIFICATE_BYTES: usize = 16 * 1024;
/// UUIDs are 36 characters.
pub const MAX_ID_LEN: usize = 64;
pub const MAX_TIMESTAMP_LEN: usize = 64;
/// base64 of a 64-byte Ed25519 signature.
pub const SIGNATURE_B64_LEN: usize = 88;

// ── Error codes ─────────────────────────────────────────────────────────────
pub const ERR_NO_TRUST_ROOT: &str = "TRUST_ROOT_REQUIRED";
pub const ERR_NOT_PRIMARY: &str = "AUTHORITY_REQUIRES_PRIMARY";
pub const ERR_CERT_INVALID: &str = "AUTHORITY_CERTIFICATE_INVALID";
pub const ERR_CERT_SIGNATURE: &str = "AUTHORITY_CERTIFICATE_SIGNATURE_INVALID";
pub const ERR_TENANT_MISMATCH: &str = "AUTHORITY_TENANT_MISMATCH";
pub const ERR_BRANCH_MISMATCH: &str = "AUTHORITY_BRANCH_MISMATCH";
pub const ERR_INSTANCE_MISMATCH: &str = "AUTHORITY_INSTANCE_MISMATCH";
pub const ERR_ROOT_MISMATCH: &str = "AUTHORITY_ROOT_MISMATCH";
pub const ERR_DUPLICATE_SERIAL: &str = "AUTHORITY_DUPLICATE_SERIAL";
pub const ERR_ALREADY_INITIALIZED: &str = "AUTHORITY_ALREADY_INITIALIZED";
pub const ERR_NOT_INITIALIZED: &str = "AUTHORITY_NOT_INITIALIZED";
pub const ERR_EPOCH_ROLLBACK: &str = "AUTHORITY_EPOCH_ROLLBACK";
pub const ERR_REVOKED: &str = "AUTHORITY_REVOKED";
pub const ERR_PARTITION_UNRESOLVED: &str = "AUTHORITY_PARTITION_UNRESOLVED";
pub const ERR_FORCED_TAKEOVER_REQUIRED: &str = "AUTHORITY_FORCED_TAKEOVER_REQUIRED";
pub const ERR_TAKEOVER_NOT_CONFIRMED: &str = "AUTHORITY_TAKEOVER_NOT_CONFIRMED";
pub const ERR_TARGET_REQUIRED: &str = "AUTHORITY_TRANSFER_TARGET_REQUIRED";

/// The owner must type this to force a takeover. It replaces no technical guarantee — it
/// exists so an irreversible, split-brain-capable act cannot happen by reflex.
pub const TAKEOVER_CONFIRMATION: &str = "FORCE_AUTHORITY_TAKEOVER_OLD_PRIMARY_IS_GONE";

/// Lifecycle of a certificate row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CertStatus {
    Active,
    Superseded,
    Revoked,
    /// Issued during recovery, but the highest epoch that ever existed is unknown, so it
    /// is deliberately NOT active. See `prepare_recovery`.
    RecoveryPending,
}

impl CertStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            CertStatus::Active => "active",
            CertStatus::Superseded => "superseded",
            CertStatus::Revoked => "revoked",
            CertStatus::RecoveryPending => "recovery_pending",
        }
    }
    pub fn parse(s: &str) -> Option<CertStatus> {
        match s {
            "active" => Some(CertStatus::Active),
            "superseded" => Some(CertStatus::Superseded),
            "revoked" => Some(CertStatus::Revoked),
            "recovery_pending" => Some(CertStatus::RecoveryPending),
            _ => None,
        }
    }
}

/// The signed part of a certificate.
///
/// Field order is declaration order and serde preserves it, so re-serializing a parsed
/// payload reproduces the exact bytes that were signed. That is what makes verification
/// independent of whitespace or key order in whatever JSON we were handed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CertificatePayload {
    pub certificate_version: u32,
    pub tenant_id: String,
    pub branch_id: String,
    pub root_key_id: String,
    pub root_generation: i64,

    pub authority_id: String,
    pub authority_epoch: i64,
    pub server_instance_id: String,
    pub primary_host_id: String,

    pub issued_at: String,
    /// §13 — must be PRESENT (may be null). serde special-cases `Option<T>` and fills a
    /// missing field with `None`, which here would mean "no predecessor" — a real claim
    /// about the authority chain — being inferred from an absent field. The signature
    /// covers it, but `from_json` must not accept the shape in the first place.
    #[serde(deserialize_with = "required_option")]
    pub previous_authority_id: Option<String>,
    pub certificate_serial: String,
}

/// An `Option` field that must be present. See `recovery::required_option` — attaching
/// `deserialize_with` without `default` is what disables serde's implicit
/// "missing Option ⇒ None".
fn required_option<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d)
}

impl CertificatePayload {
    /// The exact bytes that get signed and hashed — `canonical_bytes_v1` (§2).
    ///
    /// This used to be `serde_json::to_vec(self)`, justified by "serde emits struct fields
    /// in declaration order". That is a property of a library, not a protocol: JSON
    /// whitespace, escaping, number formatting and (once a map appears) iteration order
    /// would all silently become part of what a signature covers. A second implementation
    /// could serialize the same logical certificate to different bytes and reject a valid
    /// signature — or, worse, disagree with us about which bytes a signature protects.
    ///
    /// The field order below IS the specification. Adding a field means a new
    /// `certificate_version`, never an edit here: every certificate ever signed depends on
    /// these exact bytes.
    pub fn canonical(&self) -> Vec<u8> {
        let mut w = super::canonical::CanonicalWriter::new(
            super::canonical::DOMAIN_AUTHORITY_CERT,
            self.certificate_version,
        );
        w.string(&self.tenant_id)
            .string(&self.branch_id)
            .string(&self.root_key_id)
            .i64(self.root_generation)
            .string(&self.authority_id)
            .i64(self.authority_epoch)
            .string(&self.server_instance_id)
            .string(&self.primary_host_id)
            .string(&self.issued_at)
            .opt_string(self.previous_authority_id.as_deref())
            .string(&self.certificate_serial);
        w.finish()
    }

    pub fn payload_hash(&self) -> String {
        super::canonical::sha256_hex(&self.canonical())
    }
}

/// Payload + signature, as stored and exported.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuthorityCertificate {
    pub payload: CertificatePayload,
    /// base64 Ed25519 signature over `payload.canonical()`.
    pub signature: String,
}

impl AuthorityCertificate {
    pub fn to_json(&self) -> Result<String, &'static str> {
        serde_json::to_string(self).map_err(|_| ERR_CERT_INVALID)
    }
    /// §13 — strict. `deny_unknown_fields` rejects a certificate written by something
    /// that is not us; the size cap stops a multi-megabyte "certificate" from being
    /// parsed at all; the length bounds reject values no issuer of ours produces.
    pub fn from_json(raw: &str) -> Result<AuthorityCertificate, &'static str> {
        if raw.len() > MAX_CERTIFICATE_BYTES {
            return Err(ERR_CERT_INVALID);
        }
        let cert: AuthorityCertificate = serde_json::from_str(raw).map_err(|_| ERR_CERT_INVALID)?;
        cert.validate_structure()?;
        Ok(cert)
    }

    /// Cheap structural bounds, checked before any signature maths.
    fn validate_structure(&self) -> Result<(), &'static str> {
        let p = &self.payload;
        if p.certificate_version != CERTIFICATE_VERSION {
            return Err(ERR_CERT_INVALID);
        }
        for s in [
            &p.tenant_id,
            &p.branch_id,
            &p.root_key_id,
            &p.authority_id,
            &p.server_instance_id,
            &p.primary_host_id,
            &p.certificate_serial,
        ] {
            if s.is_empty() || s.len() > MAX_ID_LEN {
                return Err(ERR_CERT_INVALID);
            }
        }
        if p.previous_authority_id.as_ref().is_some_and(|s| s.len() > MAX_ID_LEN) {
            return Err(ERR_CERT_INVALID);
        }
        if p.issued_at.len() > MAX_TIMESTAMP_LEN {
            return Err(ERR_CERT_INVALID);
        }
        if p.authority_epoch < 1 || p.root_generation < 1 {
            return Err(ERR_CERT_INVALID);
        }
        // An Ed25519 signature is exactly 64 bytes — base64 of that is 88 characters.
        if self.signature.len() != SIGNATURE_B64_LEN {
            return Err(ERR_CERT_SIGNATURE);
        }
        use base64::Engine;
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

/// Sign a payload with the tenant root.
fn sign_payload(key: &RootKey, payload: CertificatePayload) -> AuthorityCertificate {
    use base64::Engine;
    let sig = key.sign(&payload.canonical());
    AuthorityCertificate {
        payload,
        signature: base64::engine::general_purpose::STANDARD.encode(sig),
    }
}

/// What a caller must prove about the context before a certificate means anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyContext<'a> {
    pub tenant_id: &'a str,
    pub branch_id: &'a str,
    pub root: &'a TrustRootRecord,
    /// `Some` = also require the certificate to name THIS installation.
    pub expect_instance: Option<&'a str>,
}

/// Verify a certificate from scratch: signature first, then every field we care about.
///
/// The stored columns are never trusted — this re-derives everything from the signed
/// blob. A11/A13-class attacks all reduce to "the DB says something the signature does
/// not", and this is the function that notices.
pub fn verify_certificate(
    cert: &AuthorityCertificate,
    ctx: &VerifyContext,
) -> Result<(), &'static str> {
    use base64::Engine;

    if cert.payload.certificate_version != CERTIFICATE_VERSION {
        return Err(ERR_CERT_INVALID);
    }
    // A2: the certificate must be signed by the root we actually trust.
    if cert.payload.root_key_id != ctx.root.root_key_id
        || cert.payload.root_generation != ctx.root.generation
    {
        return Err(ERR_ROOT_MISMATCH);
    }
    if !ctx.root.state.may_sign() {
        return Err(ERR_ROOT_MISMATCH);
    }

    let sig = base64::engine::general_purpose::STANDARD
        .decode(&cert.signature)
        .map_err(|_| ERR_CERT_SIGNATURE)?;
    // A6: any byte of the payload changed ⇒ canonical() differs ⇒ signature fails.
    if !trust_root::verify_signature(&ctx.root.public_key, &cert.payload.canonical(), &sig) {
        return Err(ERR_CERT_SIGNATURE);
    }

    if cert.payload.tenant_id != ctx.tenant_id {
        return Err(ERR_TENANT_MISMATCH);
    }
    if cert.payload.branch_id != ctx.branch_id {
        return Err(ERR_BRANCH_MISMATCH);
    }
    if cert.payload.authority_epoch < 1 {
        return Err(ERR_CERT_INVALID);
    }
    if let Some(inst) = ctx.expect_instance {
        // A5: a certificate naming another installation is valid — just not ours.
        if cert.payload.server_instance_id != inst {
            return Err(ERR_INSTANCE_MISMATCH);
        }
    }
    Ok(())
}

// ── DB rows ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertRow {
    pub certificate_serial: String,
    pub authority_id: String,
    pub authority_epoch: i64,
    pub server_instance_id: String,
    pub status: CertStatus,
    pub certificate: String,
}

fn row_from(r: &rusqlite::Row) -> rusqlite::Result<CertRow> {
    let status: String = r.get(4)?;
    Ok(CertRow {
        certificate_serial: r.get(0)?,
        authority_id: r.get(1)?,
        authority_epoch: r.get(2)?,
        server_instance_id: r.get(3)?,
        status: CertStatus::parse(&status).unwrap_or(CertStatus::Revoked),
        certificate: r.get(5)?,
    })
}

const SELECT_COLS: &str =
    "certificate_serial, authority_id, authority_epoch, server_instance_id, status, certificate";

pub fn load_active(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
) -> rusqlite::Result<Option<CertRow>> {
    conn.query_row(
        &format!(
            "SELECT {SELECT_COLS} FROM authority_certificates
              WHERE tenant_id = ?1 AND branch_id = ?2 AND status = 'active'"
        ),
        params![tenant_id, branch_id],
        |r| row_from(r),
    )
    .optional()
}

/// The highest epoch THIS database has ever seen. Note the qualifier: "this database".
/// It is a local maximum, not a global one — that distinction is the whole of §14.
pub fn highest_known_epoch(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(authority_epoch), 0) FROM authority_certificates
          WHERE tenant_id = ?1 AND branch_id = ?2",
        params![tenant_id, branch_id],
        |r| r.get(0),
    )
}

pub fn is_revoked(conn: &Connection, authority_id: &str) -> rusqlite::Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM authority_revocations WHERE authority_id = ?1",
        params![authority_id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

#[allow(clippy::too_many_arguments)]
fn insert_cert(
    conn: &Connection,
    cert: &AuthorityCertificate,
    status: CertStatus,
    issued_by: &str,
) -> Result<(), &'static str> {
    let p = &cert.payload;
    let now = chrono::Utc::now().to_rfc3339();
    let json = cert.to_json()?;
    conn.execute(
        "INSERT INTO authority_certificates
           (certificate_serial, tenant_id, branch_id, root_key_id, root_generation,
            authority_id, authority_epoch, server_instance_id, primary_host_id,
            previous_authority_id, certificate, payload_hash, status, issued_at,
            issued_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            p.certificate_serial,
            p.tenant_id,
            p.branch_id,
            p.root_key_id,
            p.root_generation,
            p.authority_id,
            p.authority_epoch,
            p.server_instance_id,
            p.primary_host_id,
            p.previous_authority_id,
            json,
            p.payload_hash(),
            status.as_str(),
            p.issued_at,
            issued_by,
            now,
        ],
    )
    .map_err(|e| {
        // A7: the PK on certificate_serial and the unique index on authority_id are the
        // real guards; this maps them to a stable code.
        let msg = e.to_string();
        if msg.contains("UNIQUE") || msg.contains("PRIMARY KEY") {
            ERR_DUPLICATE_SERIAL
        } else {
            ERR_CERT_INVALID
        }
    })?;
    Ok(())
}

/// Everything an issuer needs to know about where it stands.
pub struct IssueContext<'a> {
    pub conn: &'a Connection,
    pub tenant_id: &'a str,
    pub branch_id: &'a str,
    pub install_id: &'a str,
    pub primary_state: super::primary::State,
    pub root: &'a TrustRootRecord,
    pub key: &'a RootKey,
    pub owner: &'a OwnerAuth,
}

fn require_primary(ctx: &IssueContext) -> Result<(), &'static str> {
    // A12/A13: read_only is a copied or restored DB. It must not mint an authority — that
    // is precisely "promotion by copying", which M6-B2A exists to prevent.
    if !ctx.primary_state.may_write_sync() {
        return Err(ERR_NOT_PRIMARY);
    }
    if !ctx.root.state.may_sign() {
        return Err(ERR_NO_TRUST_ROOT);
    }
    // M6-B2C4 §9 — custody. A machine that committed a transfer away, or a target that has
    // not activated yet, holds everything it used to hold: a primary role, a root key file,
    // an authority row. None of that is permission to sign any more, and the DB is the only
    // place that knows the difference.
    super::transfer::require_custody(ctx.conn, ctx.tenant_id, ctx.install_id)?;
    Ok(())
}

/// M6-B2C4 §9 — the ONE gate every signing path goes through.
///
/// Five conditions, and each one exists because the other four do not imply it:
///
/// - **primary + instance match** (B2A) — a copied DB is `read_only` and must not sign.
/// - **custody is source_active or target_active** — the state machine's answer to "is this
///   machine's signing ability current?". Neither the role nor the key file knows this.
/// - **an active authority exists and names THIS install** — a certificate for another
///   machine verifies perfectly; it just is not ours to extend.
/// - **the root file matches the DB's public record** — a key file from another tenant would
///   otherwise sign certificates nobody can verify.
///
/// What was NOT sufficient before, and is the reason this function exists: "the root key
/// file is on disk" and "there is an authority row". T5 leaves both true on the source and
/// the source must not sign.
pub fn require_signing_authority(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
    install_id: &str,
    primary_state: super::primary::State,
    root: &TrustRootRecord,
) -> Result<CertRow, &'static str> {
    if !primary_state.may_write_sync() {
        return Err(ERR_NOT_PRIMARY);
    }
    if !root.state.may_sign() {
        return Err(ERR_NO_TRUST_ROOT);
    }
    super::transfer::require_custody(conn, tenant_id, install_id)?;

    let current = load_active(conn, tenant_id, branch_id)
        .map_err(|_| ERR_CERT_INVALID)?
        .ok_or(ERR_NOT_INITIALIZED)?;
    if is_revoked(conn, &current.authority_id).map_err(|_| ERR_CERT_INVALID)? {
        return Err(ERR_REVOKED);
    }
    // Only the holder of the active authority may extend it. If the role sits elsewhere,
    // this machine cannot grant itself a successor — that is the takeover path, and it must
    // be an explicit, confirmed, owner-declared act (§14).
    if current.server_instance_id != install_id {
        return Err(ERR_FORCED_TAKEOVER_REQUIRED);
    }
    Ok(current)
}

/// M6-B2C4 — sign a certificate naming the target. Writes NOTHING.
///
/// This replaces the DB half of the old `issue_transfer`, which superseded the source's
/// certificate and inserted the target's as active in the same call. §8 T1 is explicit that
/// the target's certificate stays in the transfer record and package until the target
/// activates it — so signing and recording must be separable, and this is the signing half.
#[allow(clippy::too_many_arguments)]
pub fn sign_transfer_certificate(
    tenant_id: &str,
    branch_id: &str,
    root: &TrustRootRecord,
    key: &RootKey,
    epoch: i64,
    target_install_id: &str,
    previous: Option<String>,
) -> Result<AuthorityCertificate, &'static str> {
    if target_install_id.trim().is_empty() {
        return Err(ERR_TARGET_REQUIRED);
    }
    if epoch < 1 {
        return Err(ERR_CERT_INVALID);
    }
    let payload = CertificatePayload {
        certificate_version: CERTIFICATE_VERSION,
        tenant_id: tenant_id.to_string(),
        branch_id: branch_id.to_string(),
        root_key_id: root.root_key_id.clone(),
        root_generation: root.generation,
        authority_id: uuid::Uuid::new_v4().to_string(),
        authority_epoch: epoch,
        server_instance_id: target_install_id.to_string(),
        primary_host_id: target_install_id.to_string(),
        issued_at: chrono::Utc::now().to_rfc3339(),
        previous_authority_id: previous,
        certificate_serial: uuid::Uuid::new_v4().to_string(),
    };
    Ok(sign_payload(key, payload))
}

/// M6-B2C4 §8 T7 — record a certificate as the active authority.
///
/// `pub(crate)` and deliberately dumb: it does not decide anything. Every check that makes
/// activation legitimate (commit token, commitment, root fingerprint, custody) happened in
/// `transfer::activate`, inside the same transaction this is called from.
pub(crate) fn insert_certificate_active(
    conn: &Connection,
    cert: &AuthorityCertificate,
) -> Result<(), &'static str> {
    if let Some(active) = load_active(conn, &cert.payload.tenant_id, &cert.payload.branch_id)
        .map_err(|_| ERR_CERT_INVALID)?
    {
        // The partial unique index allows one active row per tenant/branch, so anything
        // still active here has to step down first.
        conn.execute(
            "UPDATE authority_certificates SET status = 'superseded' WHERE certificate_serial = ?1",
            params![active.certificate_serial],
        )
        .map_err(|_| ERR_CERT_INVALID)?;
    }
    insert_cert(conn, cert, CertStatus::Active, "transfer")
}

fn new_payload(
    ctx: &IssueContext,
    epoch: i64,
    server_instance_id: &str,
    primary_host_id: &str,
    previous: Option<String>,
) -> CertificatePayload {
    CertificatePayload {
        certificate_version: CERTIFICATE_VERSION,
        tenant_id: ctx.tenant_id.to_string(),
        branch_id: ctx.branch_id.to_string(),
        root_key_id: ctx.root.root_key_id.clone(),
        root_generation: ctx.root.generation,
        authority_id: uuid::Uuid::new_v4().to_string(),
        authority_epoch: epoch,
        server_instance_id: server_instance_id.to_string(),
        primary_host_id: primary_host_id.to_string(),
        issued_at: chrono::Utc::now().to_rfc3339(),
        previous_authority_id: previous,
        certificate_serial: uuid::Uuid::new_v4().to_string(),
    }
}

/// §12 — the tenant/branch's FIRST authority: epoch 1, no predecessor, bound to this
/// installation.
pub fn initialize_authority(ctx: &IssueContext) -> Result<AuthorityCertificate, &'static str> {
    require_primary(ctx)?;
    if highest_known_epoch(ctx.conn, ctx.tenant_id, ctx.branch_id).map_err(|_| ERR_CERT_INVALID)? > 0
    {
        return Err(ERR_ALREADY_INITIALIZED);
    }
    let payload = new_payload(ctx, 1, ctx.install_id, ctx.install_id, None);
    let cert = sign_payload(ctx.key, payload);
    insert_cert(ctx.conn, &cert, CertStatus::Active, ctx.owner.user_id())?;
    Ok(cert)
}

// M6-B2C4 — `issue_transfer` used to live here. It signed a certificate naming the target,
// superseded the source's certificate and inserted the target's as ACTIVE, all in one call
// on the source machine. It is gone rather than deprecated, because both halves of what it
// did were wrong and leaving it reachable would leave the bug reachable:
//
//   - It moved the *claim* without the *ability*. The certificate is a statement about the
//     tenant root; signing needs the private key, which never left the source. The target
//     got an authority it could not use.
//   - It marked the target's certificate active on the SOURCE, at issue time. §8 T1 requires
//     it to stay in the transfer record until the target activates it — otherwise the source
//     has already recorded a handover that may never happen.
//
// The replacement is the two-phase `transfer::issue` … `transfer::activate`, which moves the
// root key under the owner's passphrase and has a defined point of no return.

/// M6-B2C4 — the "already on file" check that `import_transfer` used to carry.
///
/// "Known" and "current" are NOT the same thing, and conflating them is how a returning old
/// primary talks its way back in: its certificate is very much on file — as superseded.
/// Kept as its own function because `transfer::activate` needs exactly this question
/// answered before it publishes anything.
pub fn known_certificate_status(
    conn: &Connection,
    certificate_serial: &str,
) -> Result<Option<CertStatus>, &'static str> {
    let status: Option<String> = conn
        .query_row(
            "SELECT status FROM authority_certificates WHERE certificate_serial = ?1",
            params![certificate_serial],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| ERR_CERT_INVALID)?;
    Ok(status.map(|s| CertStatus::parse(&s).unwrap_or(CertStatus::Revoked)))
}

/// §14 — recovery when the old primary is NOT reachable.
///
/// The honest core of this slice. We know the highest epoch *this* database has seen, and
/// the bundle may carry a hint. Neither tells us whether the lost primary issued a higher
/// one before it died. So:
///
/// - the certificate is created and signed (it is a real, verifiable claim), but
/// - it is stored `recovery_pending`, NOT `active`, whenever the highest epoch is not
///   provably known.
///
/// What we explicitly do NOT do is jump the epoch by some margin (+1, +1000) and call the
/// result safe. A margin is a guess dressed as arithmetic: it cannot be validated,
/// and if it is wrong it silently loses the real authority's writes. Resolving this needs
/// evidence from the clients (which epoch did they last accept?) — that is B2D/B2E.
pub fn prepare_recovery(
    ctx: &IssueContext,
    hint_epoch: Option<i64>,
    confirmation: &str,
) -> Result<(AuthorityCertificate, CertStatus), &'static str> {
    require_primary(ctx)?;
    if confirmation != TAKEOVER_CONFIRMATION {
        return Err(ERR_TAKEOVER_NOT_CONFIRMED);
    }

    let local = highest_known_epoch(ctx.conn, ctx.tenant_id, ctx.branch_id)
        .map_err(|_| ERR_CERT_INVALID)?;
    let candidate = local.max(hint_epoch.unwrap_or(0)) + 1;

    // The one case where we can be sure: this DB holds the full history AND the hint does
    // not contradict it. Then "local max + 1" really is the next epoch, not a guess.
    let provably_known = local > 0 && hint_epoch.is_none_or(|h| h <= local);

    let status = if provably_known { CertStatus::Active } else { CertStatus::RecoveryPending };

    let previous = load_active(ctx.conn, ctx.tenant_id, ctx.branch_id)
        .map_err(|_| ERR_CERT_INVALID)?
        .map(|c| c.authority_id);

    let payload = new_payload(ctx, candidate, ctx.install_id, ctx.install_id, previous);
    let cert = sign_payload(ctx.key, payload);

    if status == CertStatus::Active {
        if let Some(active) =
            load_active(ctx.conn, ctx.tenant_id, ctx.branch_id).map_err(|_| ERR_CERT_INVALID)?
        {
            ctx.conn
                .execute(
                    "UPDATE authority_certificates SET status = 'superseded'
                      WHERE certificate_serial = ?1",
                    params![active.certificate_serial],
                )
                .map_err(|_| ERR_CERT_INVALID)?;
        }
    }
    insert_cert(ctx.conn, &cert, status, ctx.owner.user_id())?;
    Ok((cert, status))
}

/// §16 — revoke an authority. Owner decision, recorded, irreversible here.
pub fn revoke_authority(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
    authority_id: &str,
    reason: Option<&str>,
    owner: &OwnerAuth,
) -> Result<(), &'static str> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR IGNORE INTO authority_revocations
           (authority_id, tenant_id, branch_id, reason, revoked_at, revoked_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![authority_id, tenant_id, branch_id, reason, now, owner.user_id()],
    )
    .map_err(|_| ERR_CERT_INVALID)?;
    conn.execute(
        "UPDATE authority_certificates SET status = 'revoked', revoked_at = ?2
          WHERE authority_id = ?1",
        params![authority_id, now],
    )
    .map_err(|_| ERR_CERT_INVALID)?;
    Ok(())
}

/// §15 — what to make of a certificate we are shown. Detection only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimVerdict {
    /// Verifies and is at least as new as anything we know.
    Current,
    /// Verifies, but is older than what we know — a returning old primary.
    Rollback,
    /// Verifies, but the authority has been revoked.
    Revoked,
    /// Verifies, same epoch, different authority. Unresolvable here, by construction.
    PartitionUnresolved,
}

/// Classify a foreign claim without acting on it.
pub fn classify_claim(
    conn: &Connection,
    cert: &AuthorityCertificate,
    ctx: &VerifyContext,
) -> Result<ClaimVerdict, &'static str> {
    verify_certificate(cert, ctx)?;
    if is_revoked(conn, &cert.payload.authority_id).map_err(|_| ERR_CERT_INVALID)? {
        return Ok(ClaimVerdict::Revoked);
    }
    let known =
        highest_known_epoch(conn, ctx.tenant_id, ctx.branch_id).map_err(|_| ERR_CERT_INVALID)?;
    if cert.payload.authority_epoch < known {
        return Ok(ClaimVerdict::Rollback);
    }
    if cert.payload.authority_epoch == known && known > 0 {
        let mine = load_active(conn, ctx.tenant_id, ctx.branch_id)
            .map_err(|_| ERR_CERT_INVALID)?
            .map(|c| c.authority_id);
        if mine.as_deref() != Some(cert.payload.authority_id.as_str()) {
            return Ok(ClaimVerdict::PartitionUnresolved);
        }
    }
    Ok(ClaimVerdict::Current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::primary::{self, State};
    use crate::sync::trust_root::testkit::*;

    const ID_A: &str = "11111111-1111-4111-8111-111111111111";
    const ID_B: &str = "22222222-2222-4222-8222-222222222222";

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

    struct Env {
        conn: Connection,
        /// Cleans itself up on drop, panic included — it holds a real root key.
        dir: TempDir,
        root: TrustRootRecord,
        owner: primary::OwnerAuth,
    }

    fn env() -> Env {
        let conn = db();
        let o = owner(&conn);
        let dir = tmp_dir();
        // ID_A founds the root, so ID_A holds the custody these tests sign under.
        let root =
            trust_root::initialize_root(&conn, &dir, "tenant-1", ID_A, State::Primary, &o).unwrap();
        Env { conn, dir, root, owner: o }
    }

    impl Env {
        fn ctx<'a>(&'a self, key: &'a RootKey, install: &'a str, st: State) -> IssueContext<'a> {
            IssueContext {
                conn: &self.conn,
                tenant_id: "tenant-1",
                branch_id: "branch-main",
                install_id: install,
                primary_state: st,
                root: &self.root,
                key,
                owner: &self.owner,
            }
        }
        fn key(&self) -> RootKey {
            trust_root::load_key(&self.dir, &self.root).unwrap()
        }
        fn vctx<'a>(&'a self, inst: Option<&'a str>) -> VerifyContext<'a> {
            VerifyContext {
                tenant_id: "tenant-1",
                branch_id: "branch-main",
                root: &self.root,
                expect_instance: inst,
            }
        }

        /// Build epoch history WITHOUT the custody handover.
        ///
        /// The tests below are about the certificate chain — rollback, partition, revocation
        /// — and they need a "current authority is epoch N+1" state to test against. They are
        /// NOT about the transfer protocol, which has its own suite in `transfer.rs`. Driving
        /// the full T1…T7 here would test the transfer twice and this module's subject once.
        ///
        /// This is the old `issue_transfer` in test-only form, and naming it `force_` is the
        /// point: it does the thing production must never do again — mark the successor
        /// active at issue time — so no production path can reach it by accident.
        fn force_succession(&self, key: &RootKey, target: &str) -> AuthorityCertificate {
            let current = load_active(&self.conn, "tenant-1", "branch-main").unwrap().unwrap();
            let cert = sign_transfer_certificate(
                "tenant-1",
                "branch-main",
                &self.root,
                key,
                current.authority_epoch + 1,
                target,
                Some(current.authority_id.clone()),
            )
            .unwrap();
            self.conn
                .execute(
                    "UPDATE authority_certificates SET status = 'superseded'
                      WHERE certificate_serial = ?1",
                    params![current.certificate_serial],
                )
                .unwrap();
            insert_cert(&self.conn, &cert, CertStatus::Active, "user-owner").unwrap();
            cert
        }
    }

    // No `Drop for Env` — `TempDir` already guarantees cleanup, and a second one would
    // just be a place for the two to disagree.

    // ── A1: initial certificate is valid and correctly signed ────────────────
    #[test]
    fn a1_initial_certificate_is_valid() {
        let e = env();
        let k = e.key();
        let cert = initialize_authority(&e.ctx(&k, ID_A, State::Primary)).unwrap();

        assert_eq!(cert.payload.authority_epoch, 1, "§12: first authority is epoch 1");
        assert_eq!(cert.payload.previous_authority_id, None, "§12: no predecessor");
        assert_eq!(cert.payload.server_instance_id, ID_A);
        assert_eq!(cert.payload.primary_host_id, ID_A);
        assert_eq!(cert.payload.root_key_id, e.root.root_key_id);
        assert!(verify_certificate(&cert, &e.vctx(Some(ID_A))).is_ok());

        // stored and re-verifiable from the DB blob alone
        let row = load_active(&e.conn, "tenant-1", "branch-main").unwrap().unwrap();
        assert_eq!(row.status, CertStatus::Active);
        let reloaded = AuthorityCertificate::from_json(&row.certificate).unwrap();
        assert_eq!(reloaded, cert);
        assert!(verify_certificate(&reloaded, &e.vctx(Some(ID_A))).is_ok());
        // no expiry field exists at all — the shop must work offline
        let json = cert.to_json().unwrap();
        assert!(!json.contains("expires"), "§10: certificates must not expire");
    }

    #[test]
    fn a1b_second_initialization_is_refused() {
        let e = env();
        let k = e.key();
        initialize_authority(&e.ctx(&k, ID_A, State::Primary)).unwrap();
        assert_eq!(
            initialize_authority(&e.ctx(&k, ID_A, State::Primary)).unwrap_err(),
            ERR_ALREADY_INITIALIZED
        );
    }

    // ── A2: signed by a foreign root → refused ───────────────────────────────
    #[test]
    fn a2_certificate_from_a_foreign_root_is_refused() {
        let e = env();
        let k = e.key();
        let cert = initialize_authority(&e.ctx(&k, ID_A, State::Primary)).unwrap();

        // Another tenant root signs a payload that *claims* our root id.
        let foreign = RootKey::from_seed([5u8; 32], e.root.root_key_id.clone());
        let forged = sign_payload(&foreign, cert.payload.clone());
        assert_eq!(
            verify_certificate(&forged, &e.vctx(Some(ID_A))).unwrap_err(),
            ERR_CERT_SIGNATURE,
            "only the real tenant root can produce a verifying signature"
        );

        // …and a certificate honestly naming a different root id is a root mismatch.
        let mut p = cert.payload.clone();
        p.root_key_id = uuid::Uuid::new_v4().to_string();
        let other = sign_payload(&foreign, p);
        assert_eq!(
            verify_certificate(&other, &e.vctx(Some(ID_A))).unwrap_err(),
            ERR_ROOT_MISMATCH
        );
    }

    // ── A3/A4/A5: tenant / branch / instance mismatch ────────────────────────
    #[test]
    fn a3_a4_a5_context_mismatches_are_refused() {
        let e = env();
        let k = e.key();
        let cert = initialize_authority(&e.ctx(&k, ID_A, State::Primary)).unwrap();

        // A3 — tenant
        let t = VerifyContext {
            tenant_id: "tenant-2",
            branch_id: "branch-main",
            root: &e.root,
            expect_instance: Some(ID_A),
        };
        assert_eq!(verify_certificate(&cert, &t).unwrap_err(), ERR_TENANT_MISMATCH);

        // A4 — branch
        let b = VerifyContext {
            tenant_id: "tenant-1",
            branch_id: "branch-two",
            root: &e.root,
            expect_instance: Some(ID_A),
        };
        assert_eq!(verify_certificate(&cert, &b).unwrap_err(), ERR_BRANCH_MISMATCH);

        // A5 — instance
        assert_eq!(
            verify_certificate(&cert, &e.vctx(Some(ID_B))).unwrap_err(),
            ERR_INSTANCE_MISMATCH
        );
        // …but the same certificate is still perfectly valid in itself.
        assert!(verify_certificate(&cert, &e.vctx(None)).is_ok());
    }

    // ── A6: tampered payload ─────────────────────────────────────────────────
    #[test]
    fn a6_tampered_payload_breaks_the_signature() {
        let e = env();
        let k = e.key();
        let cert = initialize_authority(&e.ctx(&k, ID_A, State::Primary)).unwrap();

        // Each of these is exactly the escalation an attacker would want.
        let mut promote = cert.clone();
        promote.payload.authority_epoch = 9999;
        assert_eq!(
            verify_certificate(&promote, &e.vctx(Some(ID_A))).unwrap_err(),
            ERR_CERT_SIGNATURE,
            "epoch is signed — it cannot be raised after the fact"
        );

        let mut steal = cert.clone();
        steal.payload.server_instance_id = ID_B.into();
        assert_eq!(
            verify_certificate(&steal, &e.vctx(Some(ID_B))).unwrap_err(),
            ERR_CERT_SIGNATURE,
            "the named installation is signed — it cannot be repointed"
        );

        let mut serial = cert.clone();
        serial.payload.certificate_serial = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            verify_certificate(&serial, &e.vctx(Some(ID_A))).unwrap_err(),
            ERR_CERT_SIGNATURE
        );

        // payload_hash changes with any edit
        assert_ne!(cert.payload.payload_hash(), promote.payload.payload_hash());
    }

    // ── A7: duplicate serial ─────────────────────────────────────────────────
    #[test]
    fn a7_duplicate_serial_is_refused() {
        let e = env();
        let k = e.key();
        let cert = initialize_authority(&e.ctx(&k, ID_A, State::Primary)).unwrap();
        assert_eq!(
            insert_cert(&e.conn, &cert, CertStatus::Superseded, "user-owner").unwrap_err(),
            ERR_DUPLICATE_SERIAL,
            "a serial is claimed exactly once"
        );
    }

    // ── A8/A9/A10: regular transfer ──────────────────────────────────────────
    #[test]
    fn a8_a9_a10_regular_transfer() {
        let e = env();
        let k = e.key();
        let first = initialize_authority(&e.ctx(&k, ID_A, State::Primary)).unwrap();

        let second = e.force_succession(&k, ID_B);

        // A8 — epoch + 1
        assert_eq!(second.payload.authority_epoch, 2);
        // A9 — previous_authority_id points at the old authority
        assert_eq!(
            second.payload.previous_authority_id.as_deref(),
            Some(first.payload.authority_id.as_str())
        );
        // the certificate now names the TARGET, not the issuer
        assert_eq!(second.payload.server_instance_id, ID_B);
        assert_ne!(second.payload.authority_id, first.payload.authority_id);
        // signed by the same tenant root
        assert!(verify_certificate(&second, &e.vctx(Some(ID_B))).is_ok());

        // A10 — the old certificate is superseded, the new one active
        let old: String = e
            .conn
            .query_row(
                "SELECT status FROM authority_certificates WHERE certificate_serial = ?1",
                params![first.payload.certificate_serial],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(old, "superseded");
        let active = load_active(&e.conn, "tenant-1", "branch-main").unwrap().unwrap();
        assert_eq!(active.certificate_serial, second.payload.certificate_serial);
    }

    // ── A11/A12: transfer needs a primary; read_only cannot ──────────────────
    #[test]
    fn a11_a12_transfer_requires_a_matched_primary() {
        let e = env();
        let k = e.key();
        initialize_authority(&e.ctx(&k, ID_A, State::Primary)).unwrap();

        // A12 — read_only (a copied/restored DB) and every other non-primary state.
        // These now go through `require_signing_authority`, the M6-B2C4 §9 gate that every
        // signing path shares — which is why the assertion moved here rather than being
        // deleted with `issue_transfer`.
        for st in [
            State::ReadOnly,
            State::Client,
            State::Unconfigured,
            State::LegacyAdoptionRequired,
        ] {
            assert_eq!(
                require_signing_authority(&e.conn, "tenant-1", "branch-main", ID_A, st, &e.root)
                    .unwrap_err(),
                ERR_NOT_PRIMARY,
                "{st:?} must not transfer authority"
            );
        }
        // still epoch 1, nothing moved
        assert_eq!(highest_known_epoch(&e.conn, "tenant-1", "branch-main").unwrap(), 1);

        // Only the holder of the ACTIVE authority may hand it on. A machine that is not
        // the authority cannot grant itself a successor: that is the takeover path, and
        // it must be declared, not stumbled into. ID_B has no custody row at all here, so
        // the custody gate refuses before the authority question is even reached — which is
        // the correct order: "this machine is not in the custody chain" is the more
        // fundamental fact.
        assert_eq!(
            require_signing_authority(
                &e.conn, "tenant-1", "branch-main", ID_B, State::Primary, &e.root
            )
            .unwrap_err(),
            crate::sync::transfer::ERR_CUSTODY_MISSING
        );
        // §13 — the target must be explicit; no discovery, no inference.
        assert_eq!(
            sign_transfer_certificate("tenant-1", "branch-main", &e.root, &k, 2, "   ", None)
                .unwrap_err(),
            ERR_TARGET_REQUIRED
        );
    }

    // ── A13: a copied DB cannot mint an authority ────────────────────────────
    //
    // The B2A story, one level up. The copy has the whole server DB — including the
    // public trust root record — and still cannot produce a certificate, because the
    // private root key never travelled with it.
    #[test]
    fn a13_copied_db_creates_no_authority() {
        let e = env();

        // The copy runs on a different installation → read_only (B2A), and even if it
        // somehow claimed primary, it has no private root key.
        let k = e.key();
        assert_eq!(
            initialize_authority(&e.ctx(&k, ID_B, State::ReadOnly)).unwrap_err(),
            ERR_NOT_PRIMARY
        );

        // And without the key file there is nothing to load in the first place.
        std::fs::remove_file(key_file_path(&e.dir)).unwrap();
        assert_eq!(
            trust_root::load_key(&e.dir, &e.root).unwrap_err(),
            trust_root::ERR_ROOT_KEY_MISSING,
            "the public record travels with the DB; the signing key does not"
        );
        assert_eq!(
            trust_root::resolve_trust_state(&e.conn, &e.dir, "tenant-1"),
            trust_root::TrustState::RecoveryRequired
        );
        assert_eq!(highest_known_epoch(&e.conn, "tenant-1", "branch-main").unwrap(), 0);
    }

    // ── A14/A15: recovery bounds ─────────────────────────────────────────────
    #[test]
    fn a14_a15_recovery_produces_only_the_permitted_state() {
        // A15 — nothing known locally, only a hint from the bundle: the highest epoch
        // that ever existed is NOT provable ⇒ recovery_pending, never active.
        {
            let e = env();
            let k = e.key();
            let (cert, status) =
                prepare_recovery(&e.ctx(&k, ID_A, State::Primary), Some(7), TAKEOVER_CONFIRMATION)
                    .unwrap();
            assert_eq!(
                status,
                CertStatus::RecoveryPending,
                "A15: unknown highest epoch must NOT become active"
            );
            assert_eq!(cert.payload.authority_epoch, 8, "hint + 1 — a candidate, not a promise");
            assert!(
                load_active(&e.conn, "tenant-1", "branch-main").unwrap().is_none(),
                "recovery must not install itself as the active authority"
            );
            assert!(verify_certificate(&cert, &e.vctx(Some(ID_A))).is_ok(), "still a real cert");
        }
        // no local history, no hint → still not provable
        {
            let e = env();
            let k = e.key();
            let (_c, status) =
                prepare_recovery(&e.ctx(&k, ID_A, State::Primary), None, TAKEOVER_CONFIRMATION)
                    .unwrap();
            assert_eq!(status, CertStatus::RecoveryPending);
        }
        // A14 — the one provable case: this DB holds the history and the hint agrees.
        {
            let e = env();
            let k = e.key();
            initialize_authority(&e.ctx(&k, ID_A, State::Primary)).unwrap();
            let (cert, status) =
                prepare_recovery(&e.ctx(&k, ID_A, State::Primary), Some(1), TAKEOVER_CONFIRMATION)
                    .unwrap();
            assert_eq!(status, CertStatus::Active);
            assert_eq!(cert.payload.authority_epoch, 2);
            assert_eq!(
                load_active(&e.conn, "tenant-1", "branch-main").unwrap().unwrap().authority_epoch,
                2
            );
        }
        // a hint HIGHER than local history means someone else moved on without us
        {
            let e = env();
            let k = e.key();
            initialize_authority(&e.ctx(&k, ID_A, State::Primary)).unwrap();
            let (_c, status) =
                prepare_recovery(&e.ctx(&k, ID_A, State::Primary), Some(42), TAKEOVER_CONFIRMATION)
                    .unwrap();
            assert_eq!(
                status,
                CertStatus::RecoveryPending,
                "a hint beyond our history proves our history is incomplete"
            );
        }
    }

    // ── forced takeover needs the phrase ─────────────────────────────────────
    #[test]
    fn forced_takeover_requires_the_confirmation_phrase() {
        let e = env();
        let k = e.key();
        for bad in ["", "yes", "FORCE_AUTHORITY_TAKEOVER"] {
            assert_eq!(
                prepare_recovery(&e.ctx(&k, ID_A, State::Primary), Some(3), bad).unwrap_err(),
                ERR_TAKEOVER_NOT_CONFIRMED
            );
        }
        assert_eq!(
            highest_known_epoch(&e.conn, "tenant-1", "branch-main").unwrap(),
            0,
            "a refused takeover writes nothing"
        );
    }

    // ── A16: revoked authority ───────────────────────────────────────────────
    #[test]
    fn a16_revoked_authority_is_refused() {
        let e = env();
        let k = e.key();
        let cert = initialize_authority(&e.ctx(&k, ID_A, State::Primary)).unwrap();
        revoke_authority(
            &e.conn,
            "tenant-1",
            "branch-main",
            &cert.payload.authority_id,
            Some("key suspected leaked"),
            &e.owner,
        )
        .unwrap();

        assert!(is_revoked(&e.conn, &cert.payload.authority_id).unwrap());
        // it can no longer transfer — the §9 gate finds no ACTIVE authority, because
        // revocation moved the row's status out of 'active'.
        assert_eq!(
            require_signing_authority(
                &e.conn, "tenant-1", "branch-main", ID_A, State::Primary, &e.root
            )
            .unwrap_err(),
            ERR_NOT_INITIALIZED,
            "a revoked certificate is no longer the active authority"
        );
        let _ = &k;
        // and a returning holder is classified as revoked, not current
        assert_eq!(
            classify_claim(&e.conn, &cert, &e.vctx(Some(ID_A))).unwrap(),
            ClaimVerdict::Revoked
        );
        // the signature still verifies — revocation is a DB fact, not a crypto one
        assert!(verify_certificate(&cert, &e.vctx(Some(ID_A))).is_ok());
    }

    // ── A17: a lower epoch is a rollback ─────────────────────────────────────
    #[test]
    fn a17_lower_epoch_is_refused() {
        let e = env();
        let k = e.key();
        let first = initialize_authority(&e.ctx(&k, ID_A, State::Primary)).unwrap();
        e.force_succession(&k, ID_B);
        // history now: epoch 1 (superseded), epoch 2 (active)

        // The old primary comes back waving its epoch-1 certificate.
        assert_eq!(
            classify_claim(&e.conn, &first, &e.vctx(Some(ID_A))).unwrap(),
            ClaimVerdict::Rollback,
            "§15: a returning old primary must be seen as a rollback"
        );

        let e2 = env();
        let k2 = e2.key();
        initialize_authority(&e2.ctx(&k2, ID_A, State::Primary)).unwrap();
        e2.force_succession(&k2, ID_B);
        let stale = AuthorityCertificate::from_json(
            &e2.conn
                .query_row(
                    "SELECT certificate FROM authority_certificates WHERE authority_epoch = 1",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        // The stale certificate is on file as SUPERSEDED. "Known" is not "current" — and
        // this is the check `transfer::activate` runs before it publishes anything, so a
        // certificate we already moved past can never come back as active.
        assert_eq!(
            known_certificate_status(&e2.conn, &stale.payload.certificate_serial).unwrap(),
            Some(CertStatus::Superseded),
            "a returning old certificate is known — as history"
        );
        assert_eq!(
            classify_claim(&e2.conn, &stale, &e2.vctx(Some(ID_A))).unwrap(),
            ClaimVerdict::Rollback
        );
    }

    // ── A18: competing authority at the same epoch is fail-closed ────────────
    #[test]
    fn a18_competing_authority_is_fail_closed() {
        let e = env();
        let k = e.key();
        initialize_authority(&e.ctx(&k, ID_A, State::Primary)).unwrap();

        // A second, independently signed epoch-1 certificate for a different installation
        // — exactly what a partition produces: both sides legitimate, both verifying.
        let rival = sign_payload(
            &k,
            CertificatePayload {
                certificate_version: CERTIFICATE_VERSION,
                tenant_id: "tenant-1".into(),
                branch_id: "branch-main".into(),
                root_key_id: e.root.root_key_id.clone(),
                root_generation: e.root.generation,
                authority_id: uuid::Uuid::new_v4().to_string(),
                authority_epoch: 1,
                server_instance_id: ID_B.into(),
                primary_host_id: ID_B.into(),
                issued_at: "2026-07-17T00:00:00Z".into(),
                previous_authority_id: None,
                certificate_serial: uuid::Uuid::new_v4().to_string(),
            },
        );

        // It verifies perfectly. That is the point: crypto cannot break the tie.
        assert!(verify_certificate(&rival, &e.vctx(Some(ID_B))).is_ok());
        assert_eq!(
            classify_claim(&e.conn, &rival, &e.vctx(None)).unwrap(),
            ClaimVerdict::PartitionUnresolved,
            "§15: detected, never auto-resolved"
        );
        // …and the same verdict reached through the instance-bound context an activation
        // would use. Fail-closed: refuse rather than pick a winner.
        assert_eq!(
            classify_claim(&e.conn, &rival, &e.vctx(Some(ID_B))).unwrap(),
            ClaimVerdict::PartitionUnresolved,
            "fail-closed: refuse rather than pick a winner"
        );
        assert_eq!(
            known_certificate_status(&e.conn, &rival.payload.certificate_serial).unwrap(),
            None,
            "the rival is not on file — the verdict comes from the epoch, not the serial"
        );
    }

    // ── a certificate already on file as ACTIVE is recognised, not re-inserted ──
    #[test]
    fn a_known_active_certificate_is_reported_as_active() {
        let e = env();
        let k = e.key();
        initialize_authority(&e.ctx(&k, ID_A, State::Primary)).unwrap();
        let t = e.force_succession(&k, ID_B);
        // This is what makes `transfer::activate` idempotent (§11 "doppelte Target-
        // Aktivierung"): the serial is already ours and already active, so a second
        // activation is a no-op rather than a duplicate insert.
        assert_eq!(
            known_certificate_status(&e.conn, &t.payload.certificate_serial).unwrap(),
            Some(CertStatus::Active)
        );
        assert_eq!(
            known_certificate_status(&e.conn, &uuid::Uuid::new_v4().to_string()).unwrap(),
            None,
            "a serial we never saw is not 'known'"
        );
    }

    // ── A19: the private root never appears in a certificate or its text ─────
    #[test]
    fn a19_private_root_never_appears_in_a_certificate() {
        use base64::Engine;
        let e = env();
        let k = e.key();
        let cert = initialize_authority(&e.ctx(&k, ID_A, State::Primary)).unwrap();

        let seed = *k.seed();
        let seed_b64 = base64::engine::general_purpose::STANDARD.encode(seed);
        let seed_hex: String = seed.iter().map(|b| format!("{b:02x}")).collect();

        let json = cert.to_json().unwrap();
        let dbg = format!("{cert:?}");
        for text in [&json, &dbg] {
            assert!(!text.contains(&seed_b64), "seed must never be serialized");
            assert!(!text.contains(&seed_hex));
        }
        assert!(!json.as_bytes().windows(32).any(|w| w == seed));

        // Also not in the stored blob.
        let row = load_active(&e.conn, "tenant-1", "branch-main").unwrap().unwrap();
        assert!(!row.certificate.contains(&seed_b64));

        // The signature is NOT the key (a trivially broken impl would leak it here).
        assert_ne!(cert.signature, seed_b64);
    }

    // ── A20: no sync-write gate was activated ────────────────────────────────
    //
    // The most important test in this slice. B2C must be provably inert: an authority
    // certificate must not yet be able to refuse anyone's data.
    #[test]
    fn a20_no_sync_write_gate_was_activated() {
        // 1. The push gate still asks exactly ONE question, and it is B2A's.
        let routes_src = include_str!("routes.rs");
        let prod = &routes_src[..routes_src.find("#[cfg(test)]").unwrap_or(routes_src.len())];
        assert!(prod.contains("may_write_sync()"), "the B2A gate is still there");

        // M6-B2DE1 §12 — the old contract "routes.rs contains no device/cutover word at all"
        // is now too broad and had to go: §10 REQUIRES the push/pull paths to observe legacy
        // activity, which means calling `cutover::record_legacy_activity`. So the scan can no
        // longer forbid the mere strings "cutover" or "device". What it forbids instead is the
        // set of functions that would turn observation into a GATE — anything that verifies a
        // certificate, checks custody, or resolves trust as a precondition for accepting a
        // legacy write. Those never appear in a legacy sync path, and their absence is the real
        // invariant. The behaviour itself (legacy still flows, activity still blocks readiness)
        // is proved by the S* and L* tests, which §12 makes the primary evidence.
        for forbidden_gate in [
            "verify_certificate",
            "require_custody",
            "require_signing_authority",
            "classify_claim",
            "resolve_trust_state",
            "resolve_state_with_registry",
        ] {
            assert!(
                !prod.contains(forbidden_gate),
                "routes.rs must not call {forbidden_gate} — a legacy sync path may observe, never gate"
            );
        }
        // And the two things that ARE allowed now are allowed for a stated reason, not by
        // accident: the control-plane denylist (isolation) and activity observation.
        assert!(
            prod.contains("sync_policy::is_forbidden"),
            "the control-plane denylist must gate the legacy batch (§4)"
        );
        assert!(
            prod.contains("record_legacy_activity"),
            "legacy activity must be observed after a successful sync (§10)"
        );

        // 2. The write gate is still purely a function of the B2A state.
        assert!(State::Primary.may_write_sync());
        for s in [State::Client, State::Unconfigured, State::ReadOnly] {
            assert!(!s.may_write_sync());
        }

        // 3. A primary with NO trust root and NO certificate at all still writes.
        let e = env();
        assert_eq!(highest_known_epoch(&e.conn, "tenant-1", "branch-main").unwrap(), 0);
        assert!(
            load_active(&e.conn, "tenant-1", "branch-main").unwrap().is_none(),
            "no authority exists…"
        );
        assert!(
            State::Primary.may_write_sync(),
            "…and the primary may still accept sync writes: B2C changes nothing yet"
        );
    }

    // ── §13: the certificate parser is strict ────────────────────────────────
    #[test]
    fn s13_certificate_parser_is_strict() {
        let e = env();
        let k = e.key();
        let cert = initialize_authority(&e.ctx(&k, ID_A, State::Primary)).unwrap();
        let raw = cert.to_json().unwrap();
        let obj = |r: &str| -> serde_json::Value { serde_json::from_str(r).unwrap() };
        let ser = |v: &serde_json::Value| serde_json::to_string(v).unwrap();

        // unknown field — at the top level and inside the payload
        let mut v = obj(&raw);
        v["extra"] = serde_json::json!(1);
        assert_eq!(AuthorityCertificate::from_json(&ser(&v)).unwrap_err(), ERR_CERT_INVALID);
        let mut v = obj(&raw);
        v["payload"]["extra"] = serde_json::json!(1);
        assert_eq!(AuthorityCertificate::from_json(&ser(&v)).unwrap_err(), ERR_CERT_INVALID);

        // missing field — no silent default
        for f in ["authority_epoch", "tenant_id", "previous_authority_id", "certificate_serial"] {
            let mut v = obj(&raw);
            v["payload"].as_object_mut().unwrap().remove(f);
            assert!(
                AuthorityCertificate::from_json(&ser(&v)).is_err(),
                "a missing payload.{f} must not default silently"
            );
        }
        let mut v = obj(&raw);
        v.as_object_mut().unwrap().remove("signature");
        assert!(AuthorityCertificate::from_json(&ser(&v)).is_err());

        // wrong types
        for (f, bad) in [
            ("authority_epoch", serde_json::json!("one")),
            ("tenant_id", serde_json::json!(7)),
            ("certificate_version", serde_json::json!("v1")),
        ] {
            let mut v = obj(&raw);
            v["payload"][f] = bad;
            assert!(AuthorityCertificate::from_json(&ser(&v)).is_err(), "payload.{f} wrong type");
        }

        // unknown version
        for ver in [0, 2, u32::MAX] {
            let mut v = obj(&raw);
            v["payload"]["certificate_version"] = serde_json::json!(ver);
            assert_eq!(
                AuthorityCertificate::from_json(&ser(&v)).unwrap_err(),
                ERR_CERT_INVALID,
                "certificate_version {ver} must be refused"
            );
        }

        // oversized ids and whole-file cap
        let mut v = obj(&raw);
        v["payload"]["authority_id"] = serde_json::json!("x".repeat(MAX_ID_LEN + 1));
        assert_eq!(AuthorityCertificate::from_json(&ser(&v)).unwrap_err(), ERR_CERT_INVALID);
        let huge = format!("{}{}", raw, " ".repeat(MAX_CERTIFICATE_BYTES));
        assert_eq!(AuthorityCertificate::from_json(&huge).unwrap_err(), ERR_CERT_INVALID);

        // epoch / generation floors
        for (f, bad) in [("authority_epoch", 0i64), ("root_generation", 0i64)] {
            let mut v = obj(&raw);
            v["payload"][f] = serde_json::json!(bad);
            assert_eq!(AuthorityCertificate::from_json(&ser(&v)).unwrap_err(), ERR_CERT_INVALID);
        }

        // signature length is exact (64 bytes → 88 base64 chars)
        use base64::Engine;
        for bytes in [63usize, 65, 0] {
            let mut v = obj(&raw);
            v["signature"] =
                serde_json::json!(base64::engine::general_purpose::STANDARD.encode(vec![1u8; bytes]));
            assert_eq!(
                AuthorityCertificate::from_json(&ser(&v)).unwrap_err(),
                ERR_CERT_SIGNATURE,
                "a {bytes}-byte signature must be refused"
            );
        }
        let mut v = obj(&raw);
        v["signature"] = serde_json::json!("!!!not-base64!!!");
        assert!(AuthorityCertificate::from_json(&ser(&v)).is_err());

        // …and the untouched original still parses.
        assert_eq!(AuthorityCertificate::from_json(&raw).unwrap(), cert);
    }

    #[test]
    fn cert_status_roundtrips() {
        for s in [
            CertStatus::Active,
            CertStatus::Superseded,
            CertStatus::Revoked,
            CertStatus::RecoveryPending,
        ] {
            assert_eq!(CertStatus::parse(s.as_str()), Some(s));
        }
        assert_eq!(CertStatus::parse("nonsense"), None);
    }

    #[test]
    fn schema_forbids_two_active_authorities() {
        let e = env();
        let k = e.key();
        let cert = initialize_authority(&e.ctx(&k, ID_A, State::Primary)).unwrap();
        let mut p = cert.payload.clone();
        p.authority_id = uuid::Uuid::new_v4().to_string();
        p.certificate_serial = uuid::Uuid::new_v4().to_string();
        let rival = sign_payload(&k, p);
        assert_eq!(
            insert_cert(&e.conn, &rival, CertStatus::Active, "user-owner").unwrap_err(),
            ERR_DUPLICATE_SERIAL,
            "the unique partial index must forbid a second ACTIVE authority locally"
        );
    }
}
