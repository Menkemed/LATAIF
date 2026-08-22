//! MOBILE-04B2A1 — durable server-side mobile upload inbox + staging core. **INACTIVE.**
//!
//! A restart-capable Rust inbox for the embedded mobile uploader (`mobile_page.rs`). NOTHING here
//! is routed: no `/api/mobile/v1/uploads` route is registered, no capability is enabled, `/mobile`
//! does not call it, and it NEVER hands off to `createProductWithMedia` (that JS/sql.js handoff is
//! the next slice). It also NEVER writes the frontend `lataif.db` (Rust holds it read-only) and
//! NEVER uses `applyUpsert` or a `products` write path — image bytes never touch SQLite.
//!
//! Contract (create-only):
//!   • Trusted context (authenticatedUserId / tenant / branch) is server-supplied — NEVER from the
//!     mobile payload. Idempotency key = tenant + branch + authenticatedUserId + uploadEventId.
//!     This is a CREATE-only contract, NOT a CAS update/delete writer.
//!   • Only `mode = collection`; `repair` / `purchase_inbox` → typed UNSUPPORTED_MODE (no fallback).
//!   • Images are validated (25 MiB/img, 8192 px/axis, 24 MP, 8 imgs, 40 MiB/batch, MIME↔magic,
//!     raster-only, no SVG, decode-integrity) then staged CONTENT-ADDRESSED under a controlled
//!     staging root with random-free content names, reparse/symlink-guarded, fsync'd, atomic
//!     no-clobber hard-link. Files are published durably FIRST, then the `accepted` DB transaction.
//!     A crash can leave at most unreferenced staging orphans — never an `accepted` job with a
//!     missing file.
//!   • Idempotency: same key + same full payloadHash → stored-status replay; same key + different
//!     hash → typed OperationConflict; a different uploadEventId with identical content → a separate
//!     valid upload. `receivedAt`, JSON key order and server time never affect the hash.
//! NEVER logs image bytes/base64 or content paths.

#![allow(dead_code)]

use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::media::{inspect_image_bytes, normalize_stock_image, resolve_within_root, sha256_hex, ContentKind, Limits};

pub const MOBILE_UPLOAD_PROTOCOL_VERSION: i64 = 1;
// CONTRACT-V2 — the server accepts the legacy contract (1) and the full-field contract (2). v2 payloads are
// additionally validated against the desktop field SSOT (required + dependsOn) at the HTTP boundary before any
// staging. Any other version is rejected. Idempotency stays keyed on uploadEventId; the version is part of the
// payload identity (see request_hash), so a v1→v2 reuse of one id is a Conflict, never a silent replay.
pub const MOBILE_UPLOAD_SUPPORTED_PROTOCOLS: &[i64] = &[1, 2];
pub const MAX_UPLOAD_IMAGE_BYTES: usize = 25 * 1024 * 1024;
pub const MAX_UPLOAD_IMAGE_DIM: u32 = 8192;
pub const MAX_UPLOAD_IMAGE_PIXELS: u64 = 24 * 1024 * 1024;
pub const MAX_UPLOAD_IMAGES: usize = 8;
pub const MAX_UPLOAD_BATCH_BYTES: usize = 40 * 1024 * 1024;

// ── typed reject / error codes ────────────────────────────────────────────────
pub const ERR_UNSUPPORTED_MODE: &str = "MOBILE_UPLOAD_UNSUPPORTED_MODE";
pub const ERR_UNSUPPORTED_PROTOCOL: &str = "MOBILE_UPLOAD_UNSUPPORTED_PROTOCOL";
pub const ERR_SCOPE_REQUIRED: &str = "MOBILE_UPLOAD_SCOPE_REQUIRED";
pub const ERR_NO_EVENT_ID: &str = "MOBILE_UPLOAD_NO_EVENT_ID";
pub const ERR_NO_IMAGES: &str = "MOBILE_UPLOAD_NO_IMAGES";
pub const ERR_TOO_MANY_IMAGES: &str = "MOBILE_UPLOAD_TOO_MANY_IMAGES";
pub const ERR_BATCH_TOO_LARGE: &str = "MOBILE_UPLOAD_BATCH_TOO_LARGE";
pub const ERR_IMAGE_TOO_LARGE: &str = "MOBILE_UPLOAD_IMAGE_TOO_LARGE";
pub const ERR_UNSUPPORTED_MIME: &str = "MOBILE_UPLOAD_UNSUPPORTED_MIME";
pub const ERR_MIME_MISMATCH: &str = "MOBILE_UPLOAD_MIME_MISMATCH";
pub const ERR_DIMENSIONS_UNKNOWN: &str = "MOBILE_UPLOAD_DIMENSIONS_UNKNOWN";
pub const ERR_TOO_LARGE_DIMENSIONS: &str = "MOBILE_UPLOAD_TOO_LARGE_DIMENSIONS";
pub const ERR_TOO_MANY_PIXELS: &str = "MOBILE_UPLOAD_TOO_MANY_PIXELS";
pub const ERR_TRUNCATED: &str = "MOBILE_UPLOAD_TRUNCATED_OR_CORRUPT";
pub const ERR_PAYLOAD_INVALID: &str = "MOBILE_UPLOAD_PAYLOAD_INVALID";
pub const ERR_STAGING_IO: &str = "MOBILE_UPLOAD_STAGING_IO";
pub const ERR_PATH_UNSAFE: &str = "MOBILE_UPLOAD_PATH_UNSAFE";
pub const ERR_TARGET_CONFLICT: &str = "MOBILE_UPLOAD_TARGET_CONFLICT";
pub const ERR_INTEGRITY_FAILURE: &str = "MOBILE_UPLOAD_INTEGRITY_FAILURE";
pub const ERR_MANIFEST_INVALID: &str = "MOBILE_UPLOAD_MANIFEST_INVALID";
pub const ERR_CLAIM_INVALID: &str = "MOBILE_UPLOAD_CLAIM_INVALID";
/// MOBILE-04B2A4 — the runtime binding moved (owner rebind) between claim and this mutation.
pub const ERR_SCOPE_REVISION_CONFLICT: &str = "MOBILE_RUNTIME_SCOPE_REVISION_CONFLICT";

/// MOBILE-04B2A4 — the transactional scope fence. Reads the CURRENT active runtime binding for the
/// install WITHIN the caller's transaction (so the IMMEDIATE write lock serializes it against any
/// concurrent rebind) and requires the caller's expectation to match exactly. `None` = scope-agnostic
/// inbox mechanics (test-only, e.g. the state-machine unit tests); the production wrappers ALWAYS pass
/// `Some`. On any drift → `ERR_SCOPE_REVISION_CONFLICT`, and the caller rolls the transaction back so
/// nothing is written.
fn fence_scope(
    conn: &Connection,
    scope: Option<&super::mobile_runtime_scope::RuntimeScopeExpectation>,
) -> Result<(), UploadError> {
    let exp = match scope { Some(e) => e, None => return Ok(()) };
    super::mobile_runtime_scope::fence_runtime_scope(
        conn, &exp.server_instance_id, exp.binding_revision, &exp.tenant_id, &exp.branch_id,
    )
    .map_err(|_| reject(ERR_SCOPE_REVISION_CONFLICT))
}

/// The already-authenticated caller context. Built server-side from the verified session/JWT — a
/// later route derives it from `Claims { sub, tenant_id, branch_id }`; the mobile payload never
/// supplies any of these.
#[derive(Debug, Clone)]
pub struct TrustedUploadContext {
    pub authenticated_user_id: String,
    pub tenant_id: String,
    pub branch_id: String,
}

/// One raw uploaded image, in order (index 0 = primary). Bytes only — no client filename/path.
#[derive(Debug, Clone)]
pub struct RawUploadImage {
    pub declared_mime: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct UploadSubmission {
    pub protocol_version: i64,
    pub upload_event_id: String,
    pub entity_id: String,
    pub mode: String,
    /// The product metadata as a JSON object string (canonicalised server-side).
    pub metadata_json: String,
    pub images: Vec<RawUploadImage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadOutcome {
    Accepted { upload_event_id: String, payload_hash: String },
    Replay { upload_event_id: String, state: String, product_id: Option<String>, payload_hash: String },
    /// Same key, different request payload → no mutation.
    Conflict { upload_event_id: String },
    /// A DIFFERENT event id targeting an entity id already held by an active job → no second job.
    TargetConflict { upload_event_id: String },
}

#[derive(Debug)]
pub enum UploadError {
    Reject { code: &'static str },
    /// The DB was busy under contention — the caller may retry; NOT a business success.
    Retryable,
    Db(rusqlite::Error),
}
impl UploadError {
    pub fn code(&self) -> &'static str {
        match self {
            UploadError::Reject { code } => code,
            UploadError::Retryable => "MOBILE_UPLOAD_RETRYABLE",
            UploadError::Db(_) => "MOBILE_UPLOAD_DB_ERROR",
        }
    }
}
fn is_busy(e: &rusqlite::Error) -> bool {
    matches!(e, rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::DatabaseBusy || f.code == rusqlite::ErrorCode::DatabaseLocked)
}
fn is_constraint(e: &rusqlite::Error) -> bool {
    matches!(e, rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation)
}
fn map_db(e: rusqlite::Error) -> UploadError {
    if is_busy(&e) { UploadError::Retryable } else { UploadError::Db(e) }
}
fn reject(code: &'static str) -> UploadError { UploadError::Reject { code } }

struct ValidatedImage {
    slot: usize,
    primary: bool,
    mime: &'static str,
    width: u32,
    height: u32,
    byte_size: usize,
    content_hash: String,
    ext: &'static str,
}

// ── magic-byte format sniff (independent of the declared MIME) ────────────────
fn sniff_format(b: &[u8]) -> Option<(&'static str, &'static str)> {
    if b.len() >= 3 && b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff { return Some(("image/jpeg", "jpg")); }
    if b.len() >= 8 && &b[0..8] == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] { return Some(("image/png", "png")); }
    if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" { return Some(("image/webp", "webp")); }
    None
}
fn norm_declared(m: &str) -> &str {
    if m.eq_ignore_ascii_case("image/jpg") { "image/jpeg" } else { m }
}

fn validate_image(slot: usize, raw: &RawUploadImage) -> Result<ValidatedImage, UploadError> {
    if raw.bytes.is_empty() { return Err(reject(ERR_TRUNCATED)); }
    if raw.bytes.len() > MAX_UPLOAD_IMAGE_BYTES { return Err(reject(ERR_IMAGE_TOO_LARGE)); }
    let (mime, ext) = sniff_format(&raw.bytes).ok_or_else(|| reject(ERR_UNSUPPORTED_MIME))?; // GIF/SVG/other → None
    if !norm_declared(&raw.declared_mime).eq_ignore_ascii_case(mime) { return Err(reject(ERR_MIME_MISMATCH)); }
    let insp = inspect_image_bytes(&raw.bytes);
    if insp.kind != ContentKind::RasterImage { return Err(reject(ERR_UNSUPPORTED_MIME)); }
    if insp.width == 0 || insp.height == 0 { return Err(reject(ERR_DIMENSIONS_UNKNOWN)); }
    if insp.width > MAX_UPLOAD_IMAGE_DIM || insp.height > MAX_UPLOAD_IMAGE_DIM { return Err(reject(ERR_TOO_LARGE_DIMENSIONS)); }
    if insp.width as u64 * insp.height as u64 > MAX_UPLOAD_IMAGE_PIXELS { return Err(reject(ERR_TOO_MANY_PIXELS)); }
    // decode-integrity: a truncated/corrupt raster fails a real bounded decode.
    let limits = Limits { max_input_dim: MAX_UPLOAD_IMAGE_DIM, max_input_pixels: MAX_UPLOAD_IMAGE_PIXELS };
    if normalize_stock_image(&raw.bytes, &limits).is_err() { return Err(reject(ERR_TRUNCATED)); }
    Ok(ValidatedImage {
        slot, primary: slot == 0, mime, width: insp.width, height: insp.height,
        byte_size: raw.bytes.len(), content_hash: sha256_hex(&raw.bytes), ext,
    })
}

fn validate_batch(images: &[RawUploadImage]) -> Result<Vec<ValidatedImage>, UploadError> {
    validate_batch_for(images, false)
}

/// Die Felder, die ein mobiler Text-Edit setzen darf — bewusst eng und bewusst OHNE `sku`, Preise,
/// Kategorie, Attribute oder irgendetwas Bildbezogenes. Spiegelt `MOBILE_TEXT_EDIT_FIELDS` in
/// `src/core/media/mobile-upload-drain.ts`; beide Seiten pruefen, damit weder Server noch Desktop
/// sich auf den anderen verlaesst.
pub const MOBILE_TEXT_EDIT_FIELDS: [&str; 5] = ["name", "brand", "condition", "storageLocation", "notes"];
pub const ERR_EDIT_PATCH_INVALID: &str = "MOBILE_EDIT_PATCH_INVALID";
/// Laengengrenze je Textfeld — dieselbe Groessenordnung wie die Eingabefelder auf der Seite.
const MAX_EDIT_FIELD_LEN: usize = 500;

/// MOBILE-EDIT-S2 — der Patch-Vertrag: `{"patch": {feld: "wert"|null, …}}`, mindestens ein Feld,
/// nur freigegebene Felder, nur Strings oder null, jeder Wert begrenzt. Fail closed — ein
/// unbekanntes Feld macht die Anfrage ungueltig, statt still ignoriert zu werden.
pub fn validate_text_edit_metadata(meta: &Value) -> Result<(), &'static str> {
    // Das Ziel steht in der Metadata, NICHT in `entity_id`. Grund: `entity_id` traegt beim Anlegen
    // die Produkt-Id, und ein partieller UNIQUE-Index laesst pro Produkt nur EINEN aktiven Job zu —
    // ein fertiger (`ready`) Create-Job wuerde also jeden spaeteren Edit blockieren. Ein Edit bekommt
    // deshalb eine eigene Job-Identitaet und nennt sein Ziel ausdruecklich.
    let target = meta.get("productId").and_then(|v| v.as_str()).unwrap_or("");
    if target.is_empty() || target.chars().count() > 128 { return Err(ERR_EDIT_PATCH_INVALID); }
    let patch = meta.get("patch").and_then(|p| p.as_object()).ok_or(ERR_EDIT_PATCH_INVALID)?;
    if patch.is_empty() { return Err(ERR_EDIT_PATCH_INVALID); }
    for (k, v) in patch {
        if !MOBILE_TEXT_EDIT_FIELDS.contains(&k.as_str()) { return Err(ERR_EDIT_PATCH_INVALID); }
        match v {
            Value::Null => {}
            Value::String(s) if s.chars().count() <= MAX_EDIT_FIELD_LEN => {}
            _ => return Err(ERR_EDIT_PATCH_INVALID),
        }
    }
    Ok(())
}

/// MOBILE-EDIT-S2 — dieselbe Bildpruefung fuer beide Wege, mit EINEM Unterschied: ein Text-Edit
/// kommt ohne neue Bilder. Ein Create ohne Bild bleibt abgelehnt. Anzahl, Groesse und
/// Dekodierbarkeit jedes einzelnen Bildes gelten unveraendert, damit ein Edit nie einen
/// schwaecheren Vertrag bekommt als ein Create.
fn validate_batch_for(images: &[RawUploadImage], allow_empty: bool) -> Result<Vec<ValidatedImage>, UploadError> {
    if images.is_empty() && !allow_empty { return Err(reject(ERR_NO_IMAGES)); }
    if images.len() > MAX_UPLOAD_IMAGES { return Err(reject(ERR_TOO_MANY_IMAGES)); }
    let mut total = 0usize;
    let mut out = Vec::with_capacity(images.len());
    for (i, raw) in images.iter().enumerate() {
        let v = validate_image(i, raw)?;
        total = total.saturating_add(v.byte_size);
        if total > MAX_UPLOAD_BATCH_BYTES { return Err(reject(ERR_BATCH_TOO_LARGE)); }
        out.push(v);
    }
    Ok(out)
}

// ── canonical payload hash (key-order + timestamp independent) ────────────────
fn canonical_json(v: &Value) -> String {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys.iter().map(|k| format!("{}:{}", serde_json::to_string(k).unwrap(), canonical_json(&m[*k]))).collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(a) => format!("[{}]", a.iter().map(canonical_json).collect::<Vec<_>>().join(",")),
        other => serde_json::to_string(other).unwrap(),
    }
}

/// One image's frozen descriptor as it enters the payload hash. Live acceptance and stored-manifest
/// re-verification MUST build this identically so the hash is a faithful commitment to the manifest.
fn manifest_entry(slot: i64, primary: bool, mime: &str, w: i64, h: i64, size: i64, hash: &str) -> Value {
    serde_json::json!({ "slot": slot, "primary": primary, "mime": mime, "w": w, "h": h, "size": size, "hash": hash })
}
/// Canonical request hash — binds protocol, trusted scope, event/entity/mode, product metadata and the
/// full ordered image manifest. Key order and server time never affect it (`canonical_json` sorts keys).
fn request_hash(protocol: i64, t: &TrustedUploadContext, event: &str, entity: &str, mode: &str, meta: &Value, imgs: &[Value]) -> String {
    let req = serde_json::json!({
        "v": protocol,
        "tenant": t.tenant_id, "branch": t.branch_id, "user": t.authenticated_user_id,
        "uploadEventId": event, "entityId": entity, "mode": mode,
        "product": meta, "images": imgs,
    });
    sha256_hex_str(&canonical_json(&req))
}

fn payload_hash(trusted: &TrustedUploadContext, sub: &UploadSubmission, images: &[ValidatedImage]) -> Result<String, UploadError> {
    let meta: Value = serde_json::from_str(&sub.metadata_json).map_err(|_| reject(ERR_PAYLOAD_INVALID))?;
    let imgs: Vec<Value> = images.iter().map(|v|
        manifest_entry(v.slot as i64, v.primary, v.mime, v.width as i64, v.height as i64, v.byte_size as i64, &v.content_hash)
    ).collect();
    // CONTRACT-V2 — bind the ACTUAL protocol version into the payload identity (not the constant), so the live
    // hash matches the stored recompute (which already reads the stored version) AND the same uploadEventId with
    // a different version (v1 then v2) resolves to a Conflict rather than a spurious replay.
    Ok(request_hash(sub.protocol_version, trusted, &sub.upload_event_id, &sub.entity_id, &sub.mode, &meta, &imgs))
}

/// Rebuild the payload hash from the DURABLE store (inbox scope/descriptors + ordered image rows).
/// If it differs from the recorded `payload_hash`, a stored descriptor or the manifest shape was
/// altered — the frozen commitment is broken even if every file still decodes.
fn recompute_stored_payload_hash(conn: &Connection, t: &TrustedUploadContext, event: &str) -> Result<String, &'static str> {
    let (protocol, entity, mode, meta_json): (i64, String, String, String) = conn.query_row(
        "SELECT protocol_version, entity_id, mode, metadata_json FROM mobile_upload_inbox
          WHERE tenant_id=?1 AND branch_id=?2 AND authenticated_user_id=?3 AND upload_event_id=?4",
        params![t.tenant_id, t.branch_id, t.authenticated_user_id, event],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    ).map_err(|_| ERR_MANIFEST_INVALID)?;
    let meta: Value = serde_json::from_str(&meta_json).map_err(|_| ERR_MANIFEST_INVALID)?;
    let mut st = conn.prepare(
        "SELECT slot, is_primary, mime, width, height, byte_size, content_hash FROM mobile_upload_image
          WHERE tenant_id=?1 AND branch_id=?2 AND authenticated_user_id=?3 AND upload_event_id=?4 ORDER BY slot",
    ).map_err(|_| ERR_MANIFEST_INVALID)?;
    let imgs: Vec<Value> = st.query_map(
        params![t.tenant_id, t.branch_id, t.authenticated_user_id, event],
        |r| {
            let (slot, prim, mime, w, h, size, hash): (i64, i64, String, i64, i64, i64, String) =
                (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?);
            Ok(manifest_entry(slot, prim != 0, &mime, w, h, size, &hash))
        },
    ).map_err(|_| ERR_MANIFEST_INVALID)?.filter_map(|x| x.ok()).collect();
    Ok(request_hash(protocol, t, event, &entity, &mode, &meta, &imgs))
}
fn sha256_hex_str(s: &str) -> String { sha256_hex(s.as_bytes()) }

// ── reparse-safe, content-addressed durable staging ──────────────────────────
fn is_reparse(md: &fs::Metadata) -> bool {
    if md.file_type().is_symlink() { return true; }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if md.file_attributes() & 0x400 != 0 { return true; }
    }
    false
}
/// Refuse the operation if any EXISTING component under `canon_root` is a symlink/junction.
fn assert_no_reparse(canon_root: &Path, target: &Path) -> Result<(), UploadError> {
    let rel = target.strip_prefix(canon_root).map_err(|_| reject(ERR_PATH_UNSAFE))?;
    let mut cur = canon_root.to_path_buf();
    for comp in rel.components() {
        match comp {
            Component::Normal(seg) => {
                cur.push(seg);
                match fs::symlink_metadata(&cur) {
                    Ok(md) => { if is_reparse(&md) { return Err(reject(ERR_PATH_UNSAFE)); } }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return Err(reject(ERR_STAGING_IO)),
                }
            }
            _ => return Err(reject(ERR_PATH_UNSAFE)),
        }
    }
    Ok(())
}

/// Durably publish one image under the controlled staging root at a content-addressed relative key
/// `{scope}/{hash[0:2]}/{hash}.{ext}`. fsync'd temp + atomic no-clobber hard-link. Returns the
/// relative storage key. Idempotent: an identical already-present file is reused.
fn stage_image_durably(staging_root: &Path, scope: &str, bytes: &[u8], hash: &str, ext: &str) -> Result<String, UploadError> {
    let rel = format!("{scope}/{}/{hash}.{ext}", &hash[0..2]);
    fs::create_dir_all(staging_root).map_err(|_| reject(ERR_STAGING_IO))?;
    let canon = fs::canonicalize(staging_root).map_err(|_| reject(ERR_STAGING_IO))?;
    let target = resolve_within_root(&canon, &rel).map_err(|_| reject(ERR_PATH_UNSAFE))?;
    assert_no_reparse(&canon, &target)?;
    let dir = target.parent().ok_or_else(|| reject(ERR_PATH_UNSAFE))?.to_path_buf();
    fs::create_dir_all(&dir).map_err(|_| reject(ERR_STAGING_IO))?;
    if target.exists() { return Ok(rel); } // content-addressed dedup
    let tmp = dir.join(format!(".{hash}.{:016x}.tmp", rand::random::<u64>()));
    {
        let mut f = File::create(&tmp).map_err(|_| reject(ERR_STAGING_IO))?;
        f.write_all(bytes).map_err(|_| reject(ERR_STAGING_IO))?;
        f.flush().map_err(|_| reject(ERR_STAGING_IO))?;
        f.sync_all().map_err(|_| reject(ERR_STAGING_IO))?;
    }
    match fs::hard_link(&tmp, &target) {
        Ok(()) => {
            let _ = fs::remove_file(&tmp);
            let _ = File::open(&dir).and_then(|d| d.sync_all());
            Ok(rel)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => { let _ = fs::remove_file(&tmp); Ok(rel) }
        Err(_) => { let _ = fs::remove_file(&tmp); Err(reject(ERR_STAGING_IO)) }
    }
}

// ── stored-job integrity (before returning any accepted/Replay) ──────────────
/// Fully re-verify a stored job before any `accepted`/Replay return. Three layers, all fail-closed:
///  1. MANIFEST SHAPE — at least one row; slots are exactly 0..N-1 (no gap/duplicate); exactly one
///     primary and it is slot 0; a given storage_key maps to a single content_hash (dedup stays
///     self-consistent).
///  2. FROZEN COMMITMENT — the manifest recomputed from the store must equal the recorded
///     `payload_hash`, so a mutated descriptor or an added/removed image row is rejected even when
///     every file still decodes.
///  3. PHYSICAL — every file is root-confined, not a symlink/junction, present, the right size, and
///     hashes to its recorded content hash. Never reconstructs a file from client data.
fn verify_job_integrity(conn: &Connection, staging_root: &Path, t: &TrustedUploadContext, event: &str) -> Result<(), &'static str> {
    verify_and_load_manifest(conn, staging_root, t, event).map(|_| ())
}

/// Same three fail-closed layers as `verify_job_integrity`, but returns the fully verified image
/// manifest INCLUDING the physical bytes — the single source of truth for a handoff (never
/// reconstructs from client data; the bytes are exactly what hashed to the recorded content hash).
fn verify_and_load_manifest(conn: &Connection, staging_root: &Path, t: &TrustedUploadContext, event: &str) -> Result<Vec<ClaimedImage>, &'static str> {
    let canon = fs::canonicalize(staging_root).map_err(|_| ERR_INTEGRITY_FAILURE)?;
    let mut st = conn.prepare(
        "SELECT slot, is_primary, mime, width, height, byte_size, content_hash, storage_key FROM mobile_upload_image
          WHERE tenant_id=?1 AND branch_id=?2 AND authenticated_user_id=?3 AND upload_event_id=?4 ORDER BY slot",
    ).map_err(|_| ERR_MANIFEST_INVALID)?;
    let rows: Vec<(i64, i64, String, i64, i64, i64, String, String)> = st.query_map(
        params![t.tenant_id, t.branch_id, t.authenticated_user_id, event],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
    ).map_err(|_| ERR_MANIFEST_INVALID)?.filter_map(|r| r.ok()).collect();

    // 1. manifest shape
    //
    // MOBILE-EDIT-S2: ein Text-Edit-Job traegt bewusst KEIN Bild — fuer ihn ist die leere Bildliste
    // die richtige Form, und alles andere waere der Fehler. Die Pruefung wird dadurch nicht
    // schwaecher: die Job-Art steht in der Metadata, die Metadata steckt im `payload_hash`, und
    // Schicht 2 unten prueft genau diesen Hash gegen den gespeicherten Stand. Ein Create bleibt
    // ohne Bild abgelehnt.
    if rows.is_empty() {
        let meta_json: String = conn.query_row(
            "SELECT metadata_json FROM mobile_upload_inbox
              WHERE tenant_id=?1 AND branch_id=?2 AND authenticated_user_id=?3 AND upload_event_id=?4",
            params![t.tenant_id, t.branch_id, t.authenticated_user_id, event],
            |r| r.get(0),
        ).map_err(|_| ERR_MANIFEST_INVALID)?;
        let is_text_edit = serde_json::from_str::<Value>(&meta_json)
            .ok()
            .and_then(|m| m.get("kind").and_then(|v| v.as_str()).map(str::to_string))
            .as_deref() == Some("text_edit");
        if !is_text_edit { return Err(ERR_MANIFEST_INVALID); }
    }
    for (i, (slot, ..)) in rows.iter().enumerate() {
        if *slot != i as i64 { return Err(ERR_MANIFEST_INVALID); } // gap / duplicate / non-contiguous slot
    }
    let primaries: Vec<i64> = rows.iter().filter(|r| r.1 == 1).map(|r| r.0).collect();
    // Genau ein primary bei Slot 0 — und bei einer (nur fuer Text-Edits zugelassenen) leeren Liste
    // gibt es folgerichtig gar keins.
    if !rows.is_empty() && primaries != vec![0] { return Err(ERR_MANIFEST_INVALID); }
    if rows.is_empty() && !primaries.is_empty() { return Err(ERR_MANIFEST_INVALID); }
    let mut seen: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    for (_, _, _, _, _, _, hash, key) in &rows {
        if let Some(prev) = seen.insert(key, hash) { if prev != hash { return Err(ERR_MANIFEST_INVALID); } }
    }

    // 2. frozen commitment
    let stored_ph: String = conn.query_row(
        "SELECT payload_hash FROM mobile_upload_inbox
          WHERE tenant_id=?1 AND branch_id=?2 AND authenticated_user_id=?3 AND upload_event_id=?4",
        params![t.tenant_id, t.branch_id, t.authenticated_user_id, event],
        |r| r.get(0),
    ).map_err(|_| ERR_MANIFEST_INVALID)?;
    if recompute_stored_payload_hash(conn, t, event)? != stored_ph { return Err(ERR_MANIFEST_INVALID); }

    // 3. physical + load verified bytes
    let mut out = Vec::with_capacity(rows.len());
    for (slot, prim, mime, w, h, size, hash, key) in rows {
        let target = resolve_within_root(&canon, &key).map_err(|_| ERR_PATH_UNSAFE)?;
        if assert_no_reparse(&canon, &target).is_err() { return Err(ERR_PATH_UNSAFE); }
        let md = fs::metadata(&target).map_err(|_| ERR_INTEGRITY_FAILURE)?; // missing → fail closed
        if md.len() as i64 != size { return Err(ERR_INTEGRITY_FAILURE); }
        let bytes = fs::read(&target).map_err(|_| ERR_INTEGRITY_FAILURE)?;
        if sha256_hex(&bytes) != hash { return Err(ERR_INTEGRITY_FAILURE); }
        out.push(ClaimedImage {
            slot: slot as usize, primary: prim == 1, mime, width: w as u32, height: h as u32,
            byte_size: size as usize, content_hash: hash, storage_key: key,
        }); // bytes verified here but NOT returned — fetched later, one at a time
    }
    Ok(out)
}

/// Return ONE claimed image's verified bytes for the durable handoff — the bounded single-image
/// transport. Re-checks that the caller still holds the active claim (matching `claim_token`) on a
/// `processing` job in the trusted scope, then loads exactly that slot's staged file, root-confined
/// and hash-verified. A stale/foreign token, a non-processing job, or a bad slot yields no bytes.
/// Full provenance of one claimed image slot, gated by the CURRENT claim.
#[derive(Debug)]
pub struct ClaimedImageProvenance {
    pub bytes: Vec<u8>,
    pub content_hash: String,
    pub is_primary: bool,
    pub entity_id: String,
    pub payload_hash: String,
}

pub fn fetch_claimed_image(
    conn: &Connection, staging_root: &Path, trusted: &TrustedUploadContext,
    upload_event_id: &str, claim_token: &str, slot: i64, now: &str,
) -> Result<Vec<u8>, UploadError> {
    Ok(claimed_image_for_prepare(conn, staging_root, trusted, upload_event_id, claim_token, slot, now)?.bytes)
}

/// MOBILE-04B2A4 §3 — the prepare's Phase A / Phase C read, gated by the transactional scope fence.
/// Runs the fence + the claim/lease/job/manifest/provenance read under ONE IMMEDIATE tx, so it sees a
/// consistent snapshot serialized against any rebind. Phase A loads the provenance to prepare; Phase C
/// re-runs it before the prepared descriptor is released — a caller compares the two content hashes
/// and, on any drift or `ERR_SCOPE_REVISION_CONFLICT`, aborts the prepared artifact and returns
/// nothing to JS.
pub fn claimed_image_for_prepare_fenced(
    conn: &mut Connection, scope: &super::mobile_runtime_scope::RuntimeScopeExpectation, staging_root: &Path,
    trusted: &TrustedUploadContext, upload_event_id: &str, claim_token: &str, slot: i64, now: &str,
) -> Result<ClaimedImageProvenance, UploadError> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(map_db)?;
    fence_scope(&tx, Some(scope))?;
    let prov = claimed_image_for_prepare(&tx, staging_root, trusted, upload_event_id, claim_token, slot, now)?;
    tx.commit().map_err(map_db)?;
    Ok(prov)
}

/// Load one claimed image slot with the FULL provenance a prepare must bind. Claim gate (all must
/// hold, else no bytes): an active claim with the matching `claim_token` on a job still `processing`
/// whose lease has NOT expired (`lease_until >= now`) — so a stale/taken-over/expired claim prepares
/// nothing. `entity_id` and `payload_hash` come from the inbox row (never trusted from JS).
pub fn claimed_image_for_prepare(
    conn: &Connection, staging_root: &Path, trusted: &TrustedUploadContext,
    upload_event_id: &str, claim_token: &str, slot: i64, now: &str,
) -> Result<ClaimedImageProvenance, UploadError> {
    let job: Option<(String, String)> = conn.query_row(
        "SELECT i.entity_id, i.payload_hash FROM mobile_upload_claim c
           JOIN mobile_upload_inbox i
             ON i.tenant_id=c.tenant_id AND i.branch_id=c.branch_id
            AND i.authenticated_user_id=c.authenticated_user_id AND i.upload_event_id=c.upload_event_id
          WHERE c.tenant_id=?1 AND c.branch_id=?2 AND c.authenticated_user_id=?3 AND c.upload_event_id=?4
            AND c.claim_token=?5 AND i.state='processing' AND c.lease_until >= ?6",
        params![trusted.tenant_id, trusted.branch_id, trusted.authenticated_user_id, upload_event_id, claim_token, now],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).optional().map_err(map_db)?;
    let (entity_id, payload_hash) = job.ok_or_else(|| reject(ERR_CLAIM_INVALID))?;

    let (storage_key, byte_size, content_hash, is_primary): (String, i64, String, i64) = conn.query_row(
        "SELECT storage_key, byte_size, content_hash, is_primary FROM mobile_upload_image
          WHERE tenant_id=?1 AND branch_id=?2 AND authenticated_user_id=?3 AND upload_event_id=?4 AND slot=?5",
        params![trusted.tenant_id, trusted.branch_id, trusted.authenticated_user_id, upload_event_id, slot],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    ).optional().map_err(map_db)?.ok_or_else(|| reject(ERR_INTEGRITY_FAILURE))?;

    let canon = fs::canonicalize(staging_root).map_err(|_| reject(ERR_INTEGRITY_FAILURE))?;
    let target = resolve_within_root(&canon, &storage_key).map_err(|_| reject(ERR_PATH_UNSAFE))?;
    assert_no_reparse(&canon, &target)?;
    let bytes = fs::read(&target).map_err(|_| reject(ERR_INTEGRITY_FAILURE))?;
    if bytes.len() as i64 != byte_size || sha256_hex(&bytes) != content_hash {
        return Err(reject(ERR_INTEGRITY_FAILURE));
    }
    Ok(ClaimedImageProvenance { bytes, content_hash, is_primary: is_primary != 0, entity_id, payload_hash })
}

/// Deterministic prepared-request identity, canonically bound to the FULL upload provenance — scope,
/// origin user, uploadEventId, entityId, payloadHash, slot, primary and contentHash. It excludes the
/// claim token (claims change across restart/takeover) so a valid re-prepare after recovery yields
/// the SAME id (replay); any change to entityId / payloadHash / slot / primary / contentHash yields a
/// DIFFERENT id, so the media journal's per-id hash-freeze turns any reuse-with-different-bytes into a
/// typed conflict.
pub fn prepare_request_id(
    trusted: &TrustedUploadContext, upload_event_id: &str, entity_id: &str, payload_hash: &str,
    slot: i64, primary: bool, content_hash: &str,
) -> String {
    let material = format!(
        "mobile-prepare|v2|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        trusted.tenant_id, trusted.branch_id, trusted.authenticated_user_id, upload_event_id,
        entity_id, payload_hash, slot, primary as i64, content_hash,
    );
    sha256_hex(material.as_bytes())
}

fn quarantine(conn: &Connection, t: &TrustedUploadContext, event: &str, code: &str, now: &str) -> Result<(), UploadError> {
    conn.execute(
        "UPDATE mobile_upload_inbox SET state='quarantined', error_code=?5, updated_at=?6
          WHERE tenant_id=?1 AND branch_id=?2 AND authenticated_user_id=?3 AND upload_event_id=?4",
        params![t.tenant_id, t.branch_id, t.authenticated_user_id, event, code, now],
    ).map_err(map_db)?;
    Ok(())
}

// ── shared-blob lifecycle guard ───────────────────────────────────────────────
/// True iff any NON-terminal / ready inbox job still references this staged blob (by storage_key).
/// A job-local cleanup must consult this before deleting a shared content-addressed blob; orphan-GC
/// may only remove a file for which this is false. (No GC runs in this slice — contract + guard only.)
pub fn blob_still_referenced(conn: &Connection, tenant_id: &str, storage_key: &str) -> Result<bool, UploadError> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM mobile_upload_image m
           JOIN mobile_upload_inbox i
             ON i.tenant_id=m.tenant_id AND i.branch_id=m.branch_id
            AND i.authenticated_user_id=m.authenticated_user_id AND i.upload_event_id=m.upload_event_id
          WHERE m.tenant_id=?1 AND m.storage_key=?2 AND i.state IN ('accepted','processing','ready')",
        params![tenant_id, storage_key],
        |r| r.get(0),
    ).map_err(map_db)?;
    Ok(n > 0)
}
/// A staged blob is safe to delete ONLY when no active job references it.
pub fn safe_to_delete_staged(conn: &Connection, tenant_id: &str, storage_key: &str) -> Result<bool, UploadError> {
    Ok(!blob_still_referenced(conn, tenant_id, storage_key)?)
}

// ── accept ─────────────────────────────────────────────────────────────────────
/// Validate → (idempotency) → durably stage all images → durable `accepted` transaction. Files are
/// published BEFORE the DB commit, so a crash leaves at most staging orphans, never an `accepted`
/// job with a missing file. `now` is metadata only (never part of the hash).
pub fn accept_upload(
    conn: &mut Connection,
    staging_root: &Path,
    trusted: &TrustedUploadContext,
    sub: &UploadSubmission,
    now: &str,
) -> Result<UploadOutcome, UploadError> {
    if trusted.tenant_id.is_empty() || trusted.branch_id.is_empty() || trusted.authenticated_user_id.is_empty() {
        return Err(reject(ERR_SCOPE_REQUIRED));
    }
    if sub.upload_event_id.is_empty() { return Err(reject(ERR_NO_EVENT_ID)); }
    if !MOBILE_UPLOAD_SUPPORTED_PROTOCOLS.contains(&sub.protocol_version) { return Err(reject(ERR_UNSUPPORTED_PROTOCOL)); }
    // `collection` = neuer Artikel, `edit` = Textfelder eines bestehenden Artikels. repair und
    // purchase_inbox laufen weiterhin nicht ueber diesen Weg. Beide Modi teilen sich Staging,
    // Idempotenz, Ziel-Konflikt-Pruefung und den Drain — es gibt keinen zweiten Transport.
    if sub.mode != "collection" { return Err(reject(ERR_UNSUPPORTED_MODE)); } // repair/purchase_inbox
    // Der Edit-Marker sitzt in der Metadata, nicht in `mode`. Grund: die Inbox-Tabelle laesst per
    // CHECK nur `mode='collection'` zu, und diese Bedingung zu aendern hiesse die Tabelle neu zu
    // bauen — genau das, was die Migrationsdisziplin hier nicht erlaubt. Die Metadata geht in den
    // `payload_hash` ein, der Marker ist also ebenso bindend wie eine eigene Spalte, und er wird
    // hier autoritativ nachgeprueft (die Route prueft ihn schon vorher, verlaesst sich aber nicht).
    let meta: Value = serde_json::from_str(&sub.metadata_json).unwrap_or(Value::Null);
    let is_edit = meta.get("kind").and_then(|v| v.as_str()) == Some("text_edit");
    if is_edit { validate_text_edit_metadata(&meta).map_err(reject)?; }

    let validated = validate_batch_for(&sub.images, is_edit)?;
    let ph = payload_hash(trusted, sub, &validated)?;

    // idempotency by (tenant, branch, user, uploadEventId) — with stored-job integrity.
    if let Some(outcome) = replay_or_conflict(conn, staging_root, trusted, sub, &ph, now)? {
        return Ok(outcome);
    }
    // Target-entity uniqueness (create-only): a DIFFERENT event id may not target an entity id
    // already held by an active job (fast pre-check; the partial UNIQUE index is the race backstop).
    //
    // MOBILE-EDIT-S2: fuer einen Edit gilt das genau anders herum. Er zielt naturgemaess auf ein
    // Produkt, das es schon gibt — und dessen abgeschlossener (`ready`) Create-Job steht noch in der
    // Inbox. Wuerde der hier als Konflikt zaehlen, koennte ein Artikel nach dem Anlegen NIE wieder
    // bearbeitet werden. Was auch fuer einen Edit ein echter Konflikt bleibt: ein Job zum selben
    // Artikel, der GERADE laeuft (`accepted`/`processing`) — zwei gleichzeitige Mutationen an einem
    // Datensatz werden weiterhin serialisiert.
    let active_states: &[&str] = if is_edit { &["accepted", "processing"] } else { &["accepted", "processing", "ready"] };
    let placeholders = active_states.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT upload_event_id FROM mobile_upload_inbox
          WHERE tenant_id=?1 AND branch_id=?2 AND entity_id=?3 AND upload_event_id<>?4
            AND state IN ({placeholders}) LIMIT 1"
    );
    let mut args: Vec<&dyn rusqlite::ToSql> = vec![
        &trusted.tenant_id, &trusted.branch_id, &sub.entity_id, &sub.upload_event_id,
    ];
    for s in active_states { args.push(s); }
    let target_held: Option<String> = conn.query_row(
        &sql,
        rusqlite::params_from_iter(args),
        |r| r.get(0),
    ).optional().map_err(map_db)?;
    if target_held.is_some() {
        return Ok(UploadOutcome::TargetConflict { upload_event_id: sub.upload_event_id.clone() });
    }

    // FILES FIRST — durably stage every image before the accepted transaction.
    let mut staged: Vec<(String, &ValidatedImage)> = Vec::with_capacity(validated.len());
    for (v, raw) in validated.iter().zip(sub.images.iter()) {
        let key = stage_image_durably(staging_root, &trusted.tenant_id, &raw.bytes, &v.content_hash, v.ext)?;
        staged.push((key, v));
    }

    // THEN the accepted transaction — write lock up front so concurrent acceptances serialize.
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(map_db)?;
    let insert = tx.execute(
        "INSERT INTO mobile_upload_inbox
           (tenant_id, branch_id, authenticated_user_id, upload_event_id, protocol_version, entity_id,
            mode, payload_hash, metadata_json, state, product_id, error_code, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'accepted',NULL,NULL,?10,?10)",
        params![trusted.tenant_id, trusted.branch_id, trusted.authenticated_user_id, sub.upload_event_id,
            sub.protocol_version, sub.entity_id, sub.mode, ph, sub.metadata_json, now],
    );
    match insert {
        Ok(_) => {}
        Err(e) if is_busy(&e) => { drop(tx); return Err(UploadError::Retryable); }
        Err(e) if is_constraint(&e) => {
            // A concurrent writer won the race. Roll back and resolve deterministically: our key now
            // present → replay/conflict by hash; our key absent → the entity-id index fired → target conflict.
            drop(tx);
            let outcome = match replay_or_conflict(conn, staging_root, trusted, sub, &ph, now)? {
                Some(o) => o,
                None => UploadOutcome::TargetConflict { upload_event_id: sub.upload_event_id.clone() },
            };
            // Loser cleanup: this call staged files but recorded NO job. Remove only the files no
            // active job references (a shared content-addressed blob the winner uses is preserved).
            if matches!(outcome, UploadOutcome::Conflict { .. } | UploadOutcome::TargetConflict { .. }) {
                cleanup_staged_orphans(conn, staging_root, &trusted.tenant_id, &staged);
            }
            return Ok(outcome);
        }
        Err(e) => return Err(map_db(e)),
    }
    for (key, v) in &staged {
        tx.execute(
            "INSERT INTO mobile_upload_image
               (tenant_id, branch_id, authenticated_user_id, upload_event_id, slot, is_primary, mime,
                width, height, byte_size, content_hash, storage_key)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![trusted.tenant_id, trusted.branch_id, trusted.authenticated_user_id, sub.upload_event_id,
                v.slot as i64, v.primary as i64, v.mime, v.width as i64, v.height as i64, v.byte_size as i64,
                v.content_hash, key],
        ).map_err(map_db)?;
    }
    // Close the stage→(concurrent loser cleanup deletes)→commit window: while still holding the write
    // lock (which serializes against every cleanup transaction), confirm each staged file is still
    // physically present at its recorded size. If a racing cleanup removed one, roll back and report
    // Retryable — the retry re-stages — rather than commit an `accepted` job over a missing file.
    if !staged_files_present(staging_root, &staged) { drop(tx); return Err(UploadError::Retryable); }
    tx.commit().map_err(map_db)?;
    Ok(UploadOutcome::Accepted { upload_event_id: sub.upload_event_id.clone(), payload_hash: ph })
}

/// True iff every staged file is still present at its recorded size (root-confined, no reparse).
fn staged_files_present(staging_root: &Path, staged: &[(String, &ValidatedImage)]) -> bool {
    let canon = match fs::canonicalize(staging_root) { Ok(c) => c, Err(_) => return false };
    for (key, v) in staged {
        let target = match resolve_within_root(&canon, key) { Ok(t) => t, Err(_) => return false };
        if assert_no_reparse(&canon, &target).is_err() { return false; }
        match fs::metadata(&target) { Ok(md) if md.len() as usize == v.byte_size => {}, _ => return false }
    }
    true
}

/// Best-effort removal of files a losing (conflicted) call staged, ONLY when no active job
/// references them — a shared content-addressed blob used by the winner is never deleted. The
/// ref-check and the deletion run inside ONE IMMEDIATE transaction per key, so they cannot interleave
/// with a concurrent accept's commit: either the winner is already committed (ref-check sees it → keep)
/// or it has not committed and its own pre-commit presence check will fail and retry (see accept).
/// Any DB/FS uncertainty leaves the file as an orphan for a later safe GC — integrity over reclaim.
fn cleanup_staged_orphans(conn: &mut Connection, staging_root: &Path, tenant_id: &str, staged: &[(String, &ValidatedImage)]) {
    let canon = match fs::canonicalize(staging_root) { Ok(c) => c, Err(_) => return };
    for (key, _) in staged {
        let tx = match conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate) { Ok(t) => t, Err(_) => return };
        // fail-safe default = referenced (keep) on any DB error.
        let referenced = blob_still_referenced(&tx, tenant_id, key).unwrap_or(true);
        if !referenced {
            if let Ok(target) = resolve_within_root(&canon, key) {
                if assert_no_reparse(&canon, &target).is_ok() { let _ = fs::remove_file(&target); }
            }
        }
        let _ = tx.commit();
    }
}

/// Resolve an already-recorded job for this key: `None` when the key is unknown; otherwise a
/// Replay (integrity-verified for active states — a missing/corrupt file quarantines the job and
/// fails closed, never a false accepted) or a Conflict (same key, different request).
fn replay_or_conflict(
    conn: &mut Connection, staging_root: &Path, trusted: &TrustedUploadContext, sub: &UploadSubmission,
    ph: &str, now: &str,
) -> Result<Option<UploadOutcome>, UploadError> {
    let existing: Option<(String, String, Option<String>)> = conn.query_row(
        "SELECT payload_hash, state, product_id FROM mobile_upload_inbox
          WHERE tenant_id=?1 AND branch_id=?2 AND authenticated_user_id=?3 AND upload_event_id=?4",
        params![trusted.tenant_id, trusted.branch_id, trusted.authenticated_user_id, sub.upload_event_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).optional().map_err(map_db)?;
    let (stored_hash, state, product_id) = match existing {
        None => return Ok(None),
        Some(x) => x,
    };
    if stored_hash != *ph {
        return Ok(Some(UploadOutcome::Conflict { upload_event_id: sub.upload_event_id.clone() }));
    }
    if matches!(state.as_str(), "accepted" | "processing" | "ready") {
        if let Err(code) = verify_job_integrity(conn, staging_root, trusted, &sub.upload_event_id) {
            quarantine(conn, trusted, &sub.upload_event_id, code, now)?;
            return Err(reject(code)); // fail closed — never a stored-status replay over a broken job
        }
    }
    Ok(Some(UploadOutcome::Replay { upload_event_id: sub.upload_event_id.clone(), state, product_id, payload_hash: ph.to_string() }))
}

/// Status lookup (for the future GET route). Returns (state, product_id, payload_hash) or None.
pub fn get_upload_status(conn: &Connection, trusted: &TrustedUploadContext, upload_event_id: &str)
    -> Result<Option<(String, Option<String>, String)>, UploadError> {
    conn.query_row(
        "SELECT state, product_id, payload_hash FROM mobile_upload_inbox
          WHERE tenant_id=?1 AND branch_id=?2 AND authenticated_user_id=?3 AND upload_event_id=?4",
        params![trusted.tenant_id, trusted.branch_id, trusted.authenticated_user_id, upload_event_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).optional().map_err(UploadError::Db)
}

// ── MOBILE-04B2A2 — internal claim / lease / ready state machine ──────────────
// INTERNAL host bridge ONLY (Tauri commands), NEVER an HTTP route and never `mobile_page.rs`.
// Lets the JS/WebView worker lease one `accepted` job, hand its verified images to
// createProductWithMedia, then mark the same job `ready` — exactly once, restart-safe. The durable
// resume anchor is the sql.js-side `mobile_upload_receipts` row (product-atomic), NOT this table.

/// One verified image DESCRIPTOR in the claim manifest — NO bytes. The bytes are transferred later,
/// one image at a time, via `fetch_claimed_image` (bounded single-image binary transport), so a
/// claim never ships a 40 MiB JSON blob and JS never materialises all 8 images at once. `storage_key`
/// is an opaque content-addressed token, never a filesystem path the JS side can act on.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedImage {
    pub slot: usize,
    pub primary: bool,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub byte_size: usize,
    pub content_hash: String,
    pub storage_key: String,
}

/// A granted lease on one `accepted` job, with its fully re-verified manifest + bytes.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimGrant {
    pub tenant_id: String,
    pub branch_id: String,
    pub authenticated_user_id: String,
    pub upload_event_id: String,
    pub entity_id: String,
    pub payload_hash: String,
    pub mode: String,
    pub metadata_json: String,
    pub claim_token: String,
    pub claimant_instance_id: String,
    pub lease_until: String,
    pub images: Vec<ClaimedImage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadyOutcome {
    /// This call transitioned processing → ready.
    MarkedReady,
    /// Idempotent: the job is already ready for the same entity id / payload hash / product id.
    AlreadyReady,
    /// Stale/forged claim token, identity mismatch, or non-processing state — NOTHING written.
    Rejected,
}

/// Lease and claim one job for handoff. Picks the oldest job in scope that is `accepted` OR a
/// `processing` job whose lease has expired (crash of a prior claimant), fully re-verifies its
/// manifest+files, then transitions it to `processing` with a fresh `claim_token` + lease. An
/// integrity-broken candidate is quarantined (fail closed) and skipped. Returns `None` when nothing
/// is claimable. Exactly one active claim per job: the IMMEDIATE write lock + the partial UNIQUE
/// entity index serialize concurrent claimants; a stale claimant's later calls no-op on token
/// mismatch. `claim_token` / `claimant_instance_id` / `lease_until` / `now` are supplied by the host
/// command (never trusted from JS payload fields).
const CLAIM_PK_MATCH: &str =
    "c.tenant_id=mobile_upload_inbox.tenant_id AND c.branch_id=mobile_upload_inbox.branch_id \
     AND c.authenticated_user_id=mobile_upload_inbox.authenticated_user_id \
     AND c.upload_event_id=mobile_upload_inbox.upload_event_id";

pub fn claim_next_job(
    conn: &mut Connection, staging_root: &Path, tenant_id: &str, branch_id: &str,
    claimant_instance_id: &str, claim_token: &str, lease_until: &str, now: &str,
) -> Result<Option<ClaimGrant>, UploadError> {
    claim_next_job_impl(conn, None, staging_root, tenant_id, branch_id, claimant_instance_id, claim_token, lease_until, now)
}

/// MOBILE-04B2A4 §1 — claim with the transactional scope fence coupled INSIDE the IMMEDIATE tx.
pub fn claim_next_job_fenced(
    conn: &mut Connection, scope: &super::mobile_runtime_scope::RuntimeScopeExpectation, staging_root: &Path,
    tenant_id: &str, branch_id: &str, claimant_instance_id: &str, claim_token: &str, lease_until: &str, now: &str,
) -> Result<Option<ClaimGrant>, UploadError> {
    claim_next_job_impl(conn, Some(scope), staging_root, tenant_id, branch_id, claimant_instance_id, claim_token, lease_until, now)
}

fn claim_next_job_impl(
    conn: &mut Connection, scope: Option<&super::mobile_runtime_scope::RuntimeScopeExpectation>, staging_root: &Path,
    tenant_id: &str, branch_id: &str, claimant_instance_id: &str, claim_token: &str, lease_until: &str, now: &str,
) -> Result<Option<ClaimGrant>, UploadError> {
    loop {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(map_db)?;
        // §1 — fence FIRST, under the IMMEDIATE write lock, before reading/writing any job state.
        fence_scope(&tx, scope)?;
        // Oldest claimable job in the (tenant, branch) scope, across ALL origin users: `accepted`
        // (no claim row) OR `processing` whose claim lease has expired. The desktop worker leases as
        // itself (claimantInstanceId); the job's ORIGIN user is read from the row, never assumed to
        // be the worker. The whole pick→verify→claim runs under the IMMEDIATE write lock.
        let cand: Option<(String, String, String, String, String)> = tx.query_row(
            "SELECT i.authenticated_user_id, i.upload_event_id, i.entity_id, i.payload_hash, i.metadata_json
               FROM mobile_upload_inbox i
               LEFT JOIN mobile_upload_claim c
                 ON c.tenant_id=i.tenant_id AND c.branch_id=i.branch_id
                AND c.authenticated_user_id=i.authenticated_user_id AND c.upload_event_id=i.upload_event_id
              WHERE i.tenant_id=?1 AND i.branch_id=?2
                AND ( i.state='accepted'
                      OR (i.state='processing' AND c.lease_until IS NOT NULL AND c.lease_until < ?3) )
              ORDER BY i.created_at, i.upload_event_id LIMIT 1",
            params![tenant_id, branch_id, now],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        ).optional().map_err(map_db)?;
        let (origin_user, event, entity, ph, meta) = match cand {
            Some(x) => x,
            None => { let _ = tx.commit(); return Ok(None); }
        };
        // This job's trusted identity = (tenant, branch, ORIGIN user).
        let job = TrustedUploadContext { tenant_id: tenant_id.to_string(), branch_id: branch_id.to_string(), authenticated_user_id: origin_user.clone() };
        match verify_and_load_manifest(&tx, staging_root, &job, &event) {
            Ok(images) => {
                let n = tx.execute(
                    &format!(
                        "UPDATE mobile_upload_inbox SET state='processing', updated_at=?5
                          WHERE tenant_id=?1 AND branch_id=?2 AND authenticated_user_id=?3 AND upload_event_id=?4
                            AND ( state='accepted'
                                  OR ( state='processing' AND EXISTS (
                                        SELECT 1 FROM mobile_upload_claim c WHERE {CLAIM_PK_MATCH} AND c.lease_until < ?6 ) ) )"),
                    params![tenant_id, branch_id, origin_user, event, now, now],
                ).map_err(map_db)?;
                if n == 0 { let _ = tx.commit(); return Err(UploadError::Retryable); }
                // Bind the fresh claim (replacing any expired one) atomically with the state change.
                tx.execute(
                    "INSERT INTO mobile_upload_claim
                       (tenant_id, branch_id, authenticated_user_id, upload_event_id, claim_token,
                        claimant_instance_id, lease_until, created_at, updated_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8)
                     ON CONFLICT (tenant_id, branch_id, authenticated_user_id, upload_event_id)
                     DO UPDATE SET claim_token=excluded.claim_token, claimant_instance_id=excluded.claimant_instance_id,
                                   lease_until=excluded.lease_until, updated_at=excluded.updated_at",
                    params![tenant_id, branch_id, origin_user, event, claim_token, claimant_instance_id, lease_until, now],
                ).map_err(map_db)?;
                tx.commit().map_err(map_db)?;
                return Ok(Some(ClaimGrant {
                    tenant_id: tenant_id.to_string(), branch_id: branch_id.to_string(),
                    authenticated_user_id: origin_user, // ORIGIN user from the inbox job, immutable
                    upload_event_id: event, entity_id: entity, payload_hash: ph,
                    mode: "collection".into(), metadata_json: meta,
                    claim_token: claim_token.to_string(), claimant_instance_id: claimant_instance_id.to_string(),
                    lease_until: lease_until.to_string(), images,
                }));
            }
            Err(code) => {
                quarantine(&tx, &job, &event, code, now)?; // fail closed
                tx.execute(
                    "DELETE FROM mobile_upload_claim
                      WHERE tenant_id=?1 AND branch_id=?2 AND authenticated_user_id=?3 AND upload_event_id=?4",
                    params![tenant_id, branch_id, origin_user, event],
                ).map_err(map_db)?;
                tx.commit().map_err(map_db)?;
                continue; // try the next candidate
            }
        }
    }
}

/// Extend the lease of a still-held claim. No-op (returns false) unless BOTH the claim token and the
/// claimant id match the active claim row — a stale/foreign claimant (whose token was replaced on a
/// takeover) cannot renew. A claim row only ever exists for a `processing` job.
pub fn renew_claim(
    conn: &mut Connection, trusted: &TrustedUploadContext, upload_event_id: &str,
    claim_token: &str, claimant_instance_id: &str, new_lease_until: &str, now: &str,
) -> Result<bool, UploadError> {
    renew_claim_impl(conn, None, trusted, upload_event_id, claim_token, claimant_instance_id, new_lease_until, now)
}

/// MOBILE-04B2A4 §1 — renew with the transactional scope fence coupled inside the tx.
pub fn renew_claim_fenced(
    conn: &mut Connection, scope: &super::mobile_runtime_scope::RuntimeScopeExpectation,
    trusted: &TrustedUploadContext, upload_event_id: &str, claim_token: &str,
    claimant_instance_id: &str, new_lease_until: &str, now: &str,
) -> Result<bool, UploadError> {
    renew_claim_impl(conn, Some(scope), trusted, upload_event_id, claim_token, claimant_instance_id, new_lease_until, now)
}

fn renew_claim_impl(
    conn: &mut Connection, scope: Option<&super::mobile_runtime_scope::RuntimeScopeExpectation>,
    trusted: &TrustedUploadContext, upload_event_id: &str,
    claim_token: &str, claimant_instance_id: &str, new_lease_until: &str, now: &str,
) -> Result<bool, UploadError> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(map_db)?;
    fence_scope(&tx, scope)?; // §1 — the lease extension is also fenced under the write lock
    let n = tx.execute(
        "UPDATE mobile_upload_claim SET lease_until=?5, updated_at=?6
          WHERE tenant_id=?1 AND branch_id=?2 AND authenticated_user_id=?3 AND upload_event_id=?4
            AND claim_token=?7 AND claimant_instance_id=?8",
        params![trusted.tenant_id, trusted.branch_id, trusted.authenticated_user_id, upload_event_id,
            new_lease_until, now, claim_token, claimant_instance_id],
    ).map_err(map_db)?;
    tx.commit().map_err(map_db)?;
    Ok(n == 1)
}

/// Release a claim back to `accepted` (graceful abort / retry). Only a matching-token holder of a
/// `processing` job can; the claim row is removed. Returns false on token/state mismatch.
pub fn mark_retryable(
    conn: &mut Connection, trusted: &TrustedUploadContext, upload_event_id: &str, claim_token: &str, now: &str,
) -> Result<bool, UploadError> {
    release_claimed(conn, None, trusted, upload_event_id, claim_token, "accepted", None, now)
}

/// MOBILE-04B2A4 §1 — release with the transactional scope fence coupled inside the tx.
pub fn mark_retryable_fenced(
    conn: &mut Connection, scope: &super::mobile_runtime_scope::RuntimeScopeExpectation,
    trusted: &TrustedUploadContext, upload_event_id: &str, claim_token: &str, now: &str,
) -> Result<bool, UploadError> {
    release_claimed(conn, Some(scope), trusted, upload_event_id, claim_token, "accepted", None, now)
}

/// Quarantine a claimed job (manifest/file mismatch discovered by the JS verify). Matching-token +
/// `processing` only; the claim row is removed; nothing written otherwise.
pub fn mark_quarantined_claimed(
    conn: &mut Connection, trusted: &TrustedUploadContext, upload_event_id: &str, claim_token: &str, code: &str, now: &str,
) -> Result<bool, UploadError> {
    release_claimed(conn, None, trusted, upload_event_id, claim_token, "quarantined", Some(code), now)
}

/// MOBILE-04B2A4 §1 — quarantine with the transactional scope fence coupled inside the tx.
pub fn mark_quarantined_claimed_fenced(
    conn: &mut Connection, scope: &super::mobile_runtime_scope::RuntimeScopeExpectation,
    trusted: &TrustedUploadContext, upload_event_id: &str, claim_token: &str, code: &str, now: &str,
) -> Result<bool, UploadError> {
    release_claimed(conn, Some(scope), trusted, upload_event_id, claim_token, "quarantined", Some(code), now)
}

/// Shared token-guarded transition of a `processing` job to a terminal/back state + claim removal.
fn release_claimed(
    conn: &mut Connection, scope: Option<&super::mobile_runtime_scope::RuntimeScopeExpectation>,
    trusted: &TrustedUploadContext, upload_event_id: &str, claim_token: &str,
    new_state: &str, error_code: Option<&str>, now: &str,
) -> Result<bool, UploadError> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(map_db)?;
    fence_scope(&tx, scope)?; // §1 — under the write lock, before any state change
    let n = tx.execute(
        &format!(
            "UPDATE mobile_upload_inbox SET state=?5, error_code=?6, updated_at=?7
              WHERE tenant_id=?1 AND branch_id=?2 AND authenticated_user_id=?3 AND upload_event_id=?4
                AND state='processing'
                AND EXISTS (SELECT 1 FROM mobile_upload_claim c WHERE {CLAIM_PK_MATCH} AND c.claim_token=?8)"),
        params![trusted.tenant_id, trusted.branch_id, trusted.authenticated_user_id, upload_event_id,
            new_state, error_code, now, claim_token],
    ).map_err(map_db)?;
    if n == 1 {
        tx.execute(
            "DELETE FROM mobile_upload_claim
              WHERE tenant_id=?1 AND branch_id=?2 AND authenticated_user_id=?3 AND upload_event_id=?4",
            params![trusted.tenant_id, trusted.branch_id, trusted.authenticated_user_id, upload_event_id],
        ).map_err(map_db)?;
        tx.commit().map_err(map_db)?;
        Ok(true)
    } else {
        let _ = tx.commit();
        Ok(false)
    }
}

/// Transition a claimed job to `ready` after the JS side has DURABLY created the product + receipt.
/// Accepts ONLY with a matching claim token AND the exact entity id AND payload hash the claim
/// carried — a foreign product id or a different payload can never mark this job ready. Idempotent:
/// re-marking an already-ready job with the same identity returns `AlreadyReady` (crash-after-ready
/// resume). Any mismatch → `Rejected`, nothing written.
pub fn mark_ready(
    conn: &mut Connection, trusted: &TrustedUploadContext, upload_event_id: &str,
    claim_token: &str, entity_id: &str, payload_hash: &str, product_id: &str, now: &str,
) -> Result<ReadyOutcome, UploadError> {
    mark_ready_impl(conn, None, trusted, upload_event_id, claim_token, entity_id, payload_hash, product_id, now)
}

/// MOBILE-04B2A4 §1 — mark ready with the transactional scope fence coupled inside the tx.
pub fn mark_ready_fenced(
    conn: &mut Connection, scope: &super::mobile_runtime_scope::RuntimeScopeExpectation,
    trusted: &TrustedUploadContext, upload_event_id: &str, claim_token: &str, entity_id: &str,
    payload_hash: &str, product_id: &str, now: &str,
) -> Result<ReadyOutcome, UploadError> {
    mark_ready_impl(conn, Some(scope), trusted, upload_event_id, claim_token, entity_id, payload_hash, product_id, now)
}

fn mark_ready_impl(
    conn: &mut Connection, scope: Option<&super::mobile_runtime_scope::RuntimeScopeExpectation>,
    trusted: &TrustedUploadContext, upload_event_id: &str,
    claim_token: &str, entity_id: &str, payload_hash: &str, product_id: &str, now: &str,
) -> Result<ReadyOutcome, UploadError> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(map_db)?;
    fence_scope(&tx, scope)?; // §1 — under the write lock, before the ready transition
    let n = tx.execute(
        &format!(
            "UPDATE mobile_upload_inbox SET state='ready', product_id=?7, updated_at=?8
              WHERE tenant_id=?1 AND branch_id=?2 AND authenticated_user_id=?3 AND upload_event_id=?4
                AND entity_id=?6 AND payload_hash=?9 AND state='processing'
                AND EXISTS (SELECT 1 FROM mobile_upload_claim c WHERE {CLAIM_PK_MATCH} AND c.claim_token=?5)"),
        params![trusted.tenant_id, trusted.branch_id, trusted.authenticated_user_id, upload_event_id,
            claim_token, entity_id, product_id, now, payload_hash],
    ).map_err(map_db)?;
    if n == 1 {
        tx.execute(
            "DELETE FROM mobile_upload_claim
              WHERE tenant_id=?1 AND branch_id=?2 AND authenticated_user_id=?3 AND upload_event_id=?4",
            params![trusted.tenant_id, trusted.branch_id, trusted.authenticated_user_id, upload_event_id],
        ).map_err(map_db)?;
        tx.commit().map_err(map_db)?;
        return Ok(ReadyOutcome::MarkedReady);
    }
    // No transition. Distinguish an idempotent already-ready job from a stale/forged attempt.
    let existing: Option<(String, Option<String>, String, String)> = tx.query_row(
        "SELECT state, product_id, entity_id, payload_hash FROM mobile_upload_inbox
          WHERE tenant_id=?1 AND branch_id=?2 AND authenticated_user_id=?3 AND upload_event_id=?4",
        params![trusted.tenant_id, trusted.branch_id, trusted.authenticated_user_id, upload_event_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    ).optional().map_err(map_db)?;
    let _ = tx.commit();
    match existing {
        Some((st, pid, ent, ph))
            if st == "ready" && pid.as_deref() == Some(product_id) && ent == entity_id && ph == payload_hash =>
            Ok(ReadyOutcome::AlreadyReady),
        _ => Ok(ReadyOutcome::Rejected),
    }
}

#[cfg(test)]
#[path = "mobile_upload_tests.rs"]
mod mobile_upload_tests;
