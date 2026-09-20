//! MEDIA-S1 — the binary path for byte-exact originals (documents).
//!
//! The product-image path sends its (≤ 16 MB, then normalised to ≤ 100 000 B) input as a JSON
//! `number[]`: every byte becomes up to four characters of JSON, parsed on both sides. That is
//! tolerable for a photo and unusable for a 25 MB PDF. Tauri 2 (2.10.3, `tauri::ipc`) carries a
//! request body as raw bytes when the webview passes a `Uint8Array`/`ArrayBuffer` as the argument
//! (`InvokeBody::Raw`), with the metadata in request headers, and hands raw bytes back with
//! `tauri::ipc::Response` (an `ArrayBuffer` in JS). No JSON array, no Base64 copy on either leg.
//!
//! RESIDUAL RISK — the S5 decision, made and written down rather than glossed over:
//!
//!   • LAN leg (PC2 → Primary, `POST /api/documents/raw`): BOUNDED. That route carries its own
//!     `DefaultBodyLimit::max(DOCUMENT_MAX_BYTES)` inside the 50 MiB limit of every /api route.
//!     axum answers 413 from the body extractor — before the handler runs and before more than the
//!     limit is buffered. There the ceiling really does sit in front of the allocation.
//!
//!   • Tauri leg (the Primary's own window → `media_publish_original`): NOT solved, and it cannot
//!     be solved from here. Tauri 2 hands the command `InvokeBody::Raw` only once the body is
//!     complete, and this version offers no configuration that bounds an IPC body before the
//!     command is called. The guards are therefore: the client checks the size BEFORE sending
//!     (`ORIGINAL_MAX_BYTES`, the same 25 MiB) and `parse_original_upload` refuses anything larger
//!     before parsing, hashing or touching a file. What remains is one allocation of the
//!     transferred bytes inside the app's own process, caused by a file the operator picked
//!     themselves on their own machine.
//!
//! This is NOT streaming and is not described as such. 25 MiB is not raised to compensate.
//!
//! This module holds everything about that path that does not need a live webview: parsing and
//! bounding the request, and storing the original through the storage contract. The two thin
//! `#[tauri::command]` wrappers live in `lib.rs`. Nothing writes business rows here — a stored
//! original that no record ever links stays unreachable and is collected by the media GC.

use super::storage::{self, stored_kind, Published};
use super::MediaError;
use serde::Serialize;
use std::path::Path;

/// Request headers of an original upload. Lower-case: HTTP header names are case-insensitive and
/// Tauri normalises them.
pub const H_TENANT_SCOPE: &str = "x-lataif-tenant-scope";
pub const H_EXTENSION: &str = "x-lataif-extension";
pub const H_SHA256: &str = "x-lataif-sha256";

/// The ceiling of ONE raw transfer: the largest original kind the store accepts. A body above it
/// is refused before any parsing, hashing or file access.
pub fn max_raw_transport_bytes() -> u64 {
    storage::STORED_KINDS.iter().filter(|k| k.original).map(|k| k.max_bytes).max().unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OriginalUpload<'a> {
    pub tenant_scope: String,
    pub ext: String,
    pub expected_hash: Option<String>,
    pub bytes: &'a [u8],
}

/// What the caller learns about a stored original — enough to write its generation row later.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OriginalDescriptor {
    pub storage_key: String,
    pub hash: String,
    pub byte_size: usize,
    pub mime_type: String,
    pub extension: String,
    pub content_kind: String,
    pub reused: bool,
}

/// MEDIA-S1 — the OLD JSON read (`media_read_verified`) answers with a JSON `number[]`. It stays
/// for what it was built for — small renditions (product JPEGs) — and refuses every original kind:
/// those are read only through `media_read_verified_raw`. An unlisted extension is refused too.
pub fn json_read_allowed(ext: &str) -> Result<(), &'static str> {
    match stored_kind(ext) {
        Some(k) if !k.original => Ok(()),
        Some(_) => Err("MEDIA_ORIGINAL_REQUIRES_RAW_READ"),
        None => Err("MEDIA_INVALID_EXTENSION"),
    }
}

/// Validate one raw original upload. `body` is `None` when the call did not arrive as raw bytes
/// (a JSON body) — that is refused, never "converted".
pub fn parse_original_upload<'a>(
    header: impl Fn(&str) -> Option<String>,
    body: Option<&'a [u8]>,
) -> Result<OriginalUpload<'a>, &'static str> {
    let bytes = body.ok_or("MEDIA_RAW_BODY_REQUIRED")?;
    if bytes.len() as u64 > max_raw_transport_bytes() {
        return Err("MEDIA_ORIGINAL_TOO_LARGE");
    }
    if bytes.is_empty() {
        return Err("MEDIA_ORIGINAL_EMPTY");
    }
    let tenant_scope = header(H_TENANT_SCOPE).ok_or("MEDIA_TENANT_SCOPE_REQUIRED")?;
    if !storage::is_valid_scope(&tenant_scope) {
        return Err("MEDIA_TENANT_SCOPE_INVALID");
    }
    let ext = header(H_EXTENSION).ok_or("MEDIA_EXTENSION_REQUIRED")?;
    let kind = stored_kind(&ext).ok_or("MEDIA_ORIGINAL_KIND_NOT_ALLOWED")?;
    if !kind.original {
        return Err("MEDIA_ORIGINAL_KIND_NOT_ALLOWED");
    }
    if bytes.len() as u64 > kind.max_bytes {
        return Err("MEDIA_ORIGINAL_TOO_LARGE");
    }
    let expected_hash = match header(H_SHA256) {
        None => None,
        Some(h) if h.len() == 64 && h.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) => Some(h),
        Some(_) => return Err("MEDIA_SHA256_INVALID"),
    };
    Ok(OriginalUpload { tenant_scope, ext, expected_hash, bytes })
}

/// Store a validated original byte-exactly (`storage::publish_original`: kind, size, leading bytes,
/// hash — then no-clobber publish).
pub fn store_original(media_root: &Path, up: &OriginalUpload<'_>) -> Result<OriginalDescriptor, MediaError> {
    let kind = stored_kind(&up.ext).ok_or(MediaError::InvalidExtension)?;
    let p: Published = storage::publish_original(
        media_root, &up.tenant_scope, up.bytes, &up.ext, up.expected_hash.as_deref(),
    )?;
    Ok(OriginalDescriptor {
        storage_key: format!("{}/{}/{}.{}", up.tenant_scope, &p.hash[0..2], p.hash, up.ext),
        hash: p.hash,
        byte_size: p.byte_size,
        mime_type: kind.mime.to_string(),
        extension: up.ext.clone(),
        content_kind: kind.content_kind.to_string(),
        reused: p.reused,
    })
}

#[cfg(test)]
#[path = "raw_transport_tests.rs"]
mod raw_transport_tests;
