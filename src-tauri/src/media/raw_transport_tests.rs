// MEDIA-S1 — storage contract per kind + the raw binary path for originals.

use super::*;
use crate::media::storage::{
    derive_storage_path, publish_atomically, read_verified_media, sha256_hex, stored_kind, DOCUMENT_MAX_BYTES,
    RENDITION_MAX_BYTES,
};
use std::collections::HashMap;

fn tmp_dir() -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("lataif-raw-{:016x}", rand::random::<u64>()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn pdf(len: usize) -> Vec<u8> {
    let mut b = b"%PDF-1.7\n".to_vec();
    while b.len() < len {
        b.push(b'x');
    }
    b.truncate(len.max(9));
    b
}

fn hdr(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    move |k: &str| m.get(k).cloned()
}

// ── the storage contract ─────────────────────────────────────────────────────────────────────

#[test]
fn the_product_jpeg_contract_is_unchanged() {
    let k = stored_kind("jpg").unwrap();
    assert_eq!((k.mime, k.content_kind, k.original, k.max_bytes), ("image/jpeg", "raster_image", false, 100_000));
    assert_eq!(RENDITION_MAX_BYTES, 100_000);
    // a ≤ 100 000 B rendition round-trips exactly as before
    let root = tmp_dir();
    let mut bytes = vec![0xFF, 0xD8, 0xFF];
    bytes.resize(100_000, 7);
    let h = sha256_hex(&bytes);
    publish_atomically(&root, "tenant-1", &bytes, &h, "jpg").unwrap();
    assert_eq!(read_verified_media(&root, "tenant-1", &h, "jpg").unwrap(), bytes);
    // one byte more is refused on write — the rendition budget is still the budget
    let mut big = bytes.clone();
    big.push(1);
    let hb = sha256_hex(&big);
    assert!(matches!(publish_atomically(&root, "tenant-1", &big, &hb, "jpg"), Err(MediaError::FileTooLarge)));
}

#[test]
fn only_listed_kinds_have_a_storage_path() {
    let root = std::path::Path::new("C:\\m");
    let h = "a".repeat(64);
    assert!(derive_storage_path(root, "tenant-1", &h, "jpg").is_ok());
    assert!(derive_storage_path(root, "tenant-1", &h, "pdf").is_ok());
    for bad in ["png", "exe", "jpeg", "", "JPG", "pdf.exe"] {
        assert!(matches!(derive_storage_path(root, "tenant-1", &h, bad), Err(MediaError::InvalidExtension)), "{bad}");
    }
}

#[test]
fn a_pdf_original_is_stored_byte_exact_and_verified_by_its_own_limit() {
    let root = tmp_dir();
    let bytes = pdf(300_000); // three times the image budget: must NOT fail for being "not a jpg"
    let p = storage::publish_original(&root, "tenant-1", &bytes, "pdf", None).unwrap();
    assert_eq!(p.hash, sha256_hex(&bytes));
    let back = read_verified_media(&root, "tenant-1", &p.hash, "pdf").unwrap();
    assert_eq!(back, bytes, "byte-exact — nothing normalised");
    // same bytes again: verified reuse, no clobber
    assert!(storage::publish_original(&root, "tenant-1", &bytes, "pdf", Some(&p.hash)).unwrap().reused);
}

#[test]
fn originals_fail_closed_on_type_size_and_hash() {
    let root = tmp_dir();
    // not a PDF inside
    let fake = b"MZ\x90\x00 not a pdf".to_vec();
    assert!(matches!(storage::publish_original(&root, "tenant-1", &fake, "pdf", None), Err(MediaError::InvalidExtension)));
    // a rendition kind is never taken as an original
    let jpg = vec![0xFF, 0xD8, 0xFF, 1, 2, 3];
    assert!(matches!(storage::publish_original(&root, "tenant-1", &jpg, "jpg", None), Err(MediaError::InvalidExtension)));
    // unlisted kind
    assert!(matches!(storage::publish_original(&root, "tenant-1", &pdf(20), "docx", None), Err(MediaError::InvalidExtension)));
    // wrong expected hash
    assert!(matches!(
        storage::publish_original(&root, "tenant-1", &pdf(20), "pdf", Some(&"0".repeat(64))),
        Err(MediaError::FileHashMismatch)
    ));
    // empty
    assert!(matches!(storage::publish_original(&root, "tenant-1", &[], "pdf", None), Err(MediaError::FileTooLarge)));
    // a stored file whose bytes no longer match is refused on read
    let good = pdf(1000);
    let p = storage::publish_original(&root, "tenant-1", &good, "pdf", None).unwrap();
    std::fs::write(&p.path, pdf(1001)).unwrap();
    assert!(matches!(read_verified_media(&root, "tenant-1", &p.hash, "pdf"), Err(MediaError::FileHashMismatch)));
    // a planted file above the kind limit is refused before it is read
    std::fs::write(&p.path, vec![b'%'; (DOCUMENT_MAX_BYTES + 1) as usize]).unwrap();
    assert!(matches!(read_verified_media(&root, "tenant-1", &p.hash, "pdf"), Err(MediaError::FileTooLarge)));
}

// ── the raw transport ────────────────────────────────────────────────────────────────────────

#[test]
fn a_raw_original_upload_is_parsed_from_headers_and_body() {
    let body = pdf(50);
    let h = sha256_hex(&body);
    let up = parse_original_upload(
        hdr(&[(H_TENANT_SCOPE, "tenant-1"), (H_EXTENSION, "pdf"), (H_SHA256, &h)]),
        Some(&body),
    )
    .unwrap();
    assert_eq!((up.tenant_scope.as_str(), up.ext.as_str(), up.expected_hash.as_deref()), ("tenant-1", "pdf", Some(h.as_str())));
    let root = tmp_dir();
    let d = store_original(&root, &up).unwrap();
    assert_eq!(d.storage_key, format!("tenant-1/{}/{}.pdf", &h[0..2], h));
    assert_eq!((d.mime_type.as_str(), d.content_kind.as_str(), d.byte_size), ("application/pdf", "pdf", 50));
    assert_eq!(read_verified_media(&root, "tenant-1", &h, "pdf").unwrap(), body);
}

#[test]
fn raw_uploads_have_hard_limits_and_clear_errors() {
    let ok = |b: Option<&[u8]>, h: &[(&str, &str)]| parse_original_upload(hdr(h), b).map(|_| ()).unwrap_err();
    let base = [(H_TENANT_SCOPE, "tenant-1"), (H_EXTENSION, "pdf")];
    let body = pdf(10);
    assert_eq!(ok(None, &base), "MEDIA_RAW_BODY_REQUIRED", "a JSON body is not converted");
    assert_eq!(ok(Some(&[]), &base), "MEDIA_ORIGINAL_EMPTY");
    let too_big = vec![b'%'; (max_raw_transport_bytes() + 1) as usize];
    assert_eq!(ok(Some(&too_big), &base), "MEDIA_ORIGINAL_TOO_LARGE");
    assert_eq!(ok(Some(&body), &[(H_EXTENSION, "pdf")]), "MEDIA_TENANT_SCOPE_REQUIRED");
    assert_eq!(ok(Some(&body), &[(H_TENANT_SCOPE, "../x"), (H_EXTENSION, "pdf")]), "MEDIA_TENANT_SCOPE_INVALID");
    assert_eq!(ok(Some(&body), &[(H_TENANT_SCOPE, "tenant-1")]), "MEDIA_EXTENSION_REQUIRED");
    assert_eq!(ok(Some(&body), &[(H_TENANT_SCOPE, "tenant-1"), (H_EXTENSION, "jpg")]), "MEDIA_ORIGINAL_KIND_NOT_ALLOWED");
    assert_eq!(ok(Some(&body), &[(H_TENANT_SCOPE, "tenant-1"), (H_EXTENSION, "exe")]), "MEDIA_ORIGINAL_KIND_NOT_ALLOWED");
    assert_eq!(ok(Some(&body), &[(H_TENANT_SCOPE, "tenant-1"), (H_EXTENSION, "pdf"), (H_SHA256, "XYZ")]), "MEDIA_SHA256_INVALID");
    assert_eq!(max_raw_transport_bytes(), DOCUMENT_MAX_BYTES);
}

// ── the data-location move asks the same question: which files must exist ─────────────────────
#[test]
fn the_required_set_names_a_pdf_by_its_stored_extension() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    let h = "c".repeat(64);
    conn.execute_batch(&format!(
        "CREATE TABLE media_links(tenant_id,media_id,media_role,deleted_at);
         CREATE TABLE media_objects(tenant_id,media_id,master_blob_id,deleted_at);
         CREATE TABLE media_blobs(tenant_id,blob_id,blob_status,current_generation_no);
         CREATE TABLE media_blob_generations(tenant_id,blob_id,generation_no,gen_status,storage_key,stored_blob_hash,byte_size,extension);
         CREATE TABLE media_variants(tenant_id,variant_id,media_id,variant_type,blob_id,deleted_at);
         CREATE TABLE media_ingest_jobs(tenant_id,target_media_id,target_blob_id,state);
         INSERT INTO media_links VALUES('t','md','document',NULL);
         INSERT INTO media_objects VALUES('t','md','bd',NULL);
         INSERT INTO media_blobs VALUES('t','bd','present',1);
         INSERT INTO media_blob_generations VALUES('t','bd',1,'available','t/cc/{h}.pdf','{h}',300000,'pdf');"
    )).unwrap();
    let keys = crate::media::reachability::required_keys(&conn).unwrap();
    assert!(keys.contains(&format!("t/cc/{h}.pdf")), "{keys:?}");
}
