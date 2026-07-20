//! MEDIA-04A-2A — ingest service + journal test matrix. Temp roots only; no
//! productive path, DB or app is touched.

use super::*;
use std::path::{Path, PathBuf};
use std::sync::Arc;

// ── harness ──────────────────────────────────────────────────────────────────

struct TempRoot(PathBuf);
impl TempRoot {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("lataif_ingest_{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&p).unwrap();
        TempRoot(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const SCOPE: &str = "tenant-1";
const REQ_ID: &str = "11111111-1111-4111-8111-111111111111";

fn png_bytes(w: u32, h: u32) -> Vec<u8> {
    let mut img = image::RgbImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            img.put_pixel(
                x,
                y,
                image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x * 3 + y) % 256) as u8]),
            );
        }
    }
    let mut buf = Vec::new();
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
        .unwrap();
    buf
}

fn journal_file(root: &Path, scope: &str, id: &str) -> PathBuf {
    root.join(".ingest-journal")
        .join(format!("{scope}__{id}.json"))
}
fn temp_file(root: &Path, scope: &str, id: &str, which: &str) -> PathBuf {
    root.join(".ingest-journal")
        .join(format!("{scope}__{id}.{which}.jpg.tmp"))
}
fn final_file(root: &Path, scope: &str, hash: &str) -> PathBuf {
    root.join(scope)
        .join(&hash[0..2])
        .join(format!("{hash}.jpg"))
}
fn load_j(root: &Path, scope: &str, id: &str) -> IngestJournal {
    serde_json::from_slice(&std::fs::read(journal_file(root, scope, id)).unwrap()).unwrap()
}
fn save_j(root: &Path, j: &IngestJournal) {
    std::fs::write(
        journal_file(root, &j.tenant_scope, &j.ingest_request_id),
        serde_json::to_vec_pretty(j).unwrap(),
    )
    .unwrap();
}

fn svc_and_input() -> (MediaIngestService, TempRoot, Vec<u8>, String) {
    let root = TempRoot::new();
    let svc = MediaIngestService::new(root.path().to_path_buf());
    let bytes = png_bytes(640, 480);
    let hash = super::canonical_request_hash(SCOPE, &bytes);
    (svc, root, bytes, hash)
}

// ── prepare ──────────────────────────────────────────────────────────────────

#[test]
fn prepare_success_sizes_and_journal() {
    let (svc, root, bytes, hash) = svc_and_input();
    let r = svc
        .prepare(SCOPE, REQ_ID, &hash, &bytes, Some("photo.png"))
        .unwrap();
    assert_eq!(r.state, IngestState::Prepared);
    assert!(r.main_descriptor.byte_size <= 100_000);
    assert!(r.thumbnail_descriptor.byte_size <= 20_000);
    assert_eq!(r.main_descriptor.mime_type, "image/jpeg");
    // journal + both temp files exist
    assert!(journal_file(root.path(), SCOPE, REQ_ID).exists());
    assert!(temp_file(root.path(), SCOPE, REQ_ID, "main").exists());
    assert!(temp_file(root.path(), SCOPE, REQ_ID, "thumb").exists());
    let j = load_j(root.path(), SCOPE, REQ_ID);
    assert_eq!(j.state, IngestState::Prepared);
    assert_eq!(j.request_hash, hash);
}

#[test]
fn prepare_retry_same_hash_is_frozen_no_second_temp_set() {
    let (svc, root, bytes, hash) = svc_and_input();
    let a = svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    let b = svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    assert_eq!(a.main_descriptor, b.main_descriptor);
    assert_eq!(a.thumbnail_descriptor, b.thumbnail_descriptor);
    // exactly the two staged temp files, no duplicates
    let n_tmp = std::fs::read_dir(root.path().join(".ingest-journal"))
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".jpg.tmp"))
        .count();
    assert_eq!(
        n_tmp, 2,
        "a retry must not create a second set of temp files"
    );
}

#[test]
fn prepare_same_id_different_hash_conflicts() {
    let (svc, root, bytes, hash) = svc_and_input();
    svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    // different bytes → different canonical hash, but we must pass a hash that
    // matches the *new* bytes to reach the id-collision branch.
    let other = png_bytes(320, 200);
    let other_hash = super::canonical_request_hash(SCOPE, &other);
    let err = svc
        .prepare(SCOPE, REQ_ID, &other_hash, &other, None)
        .unwrap_err();
    assert_eq!(err.code(), "MEDIA_INGEST_REQUEST_CONFLICT");
    let _ = root;
}

#[test]
fn prepare_rejects_client_hash_not_matching_bytes() {
    let (svc, _root, bytes, _hash) = svc_and_input();
    let wrong = super::canonical_request_hash(SCOPE, b"different content");
    let err = svc
        .prepare(SCOPE, REQ_ID, &wrong, &bytes, None)
        .unwrap_err();
    assert_eq!(err.code(), "MEDIA_INGEST_REQUEST_CONFLICT");
}

// ── commit ───────────────────────────────────────────────────────────────────

#[test]
fn commit_success_publishes_both_finals() {
    let (svc, _root, bytes, hash) = svc_and_input();
    let p = svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    let c = svc.commit(SCOPE, REQ_ID, &hash).unwrap();
    assert_eq!(c.state, IngestState::Published);
    // both finals readable and hash-verified through the core
    assert!(svc.read(SCOPE, &p.main_descriptor.hash, "jpg").is_ok());
    assert!(svc.read(SCOPE, &p.thumbnail_descriptor.hash, "jpg").is_ok());
    assert_eq!(
        c.main_storage_key,
        super::storage_key(SCOPE, &p.main_descriptor.hash)
    );
}

#[test]
fn commit_retry_is_frozen_identical() {
    let (svc, root, bytes, hash) = svc_and_input();
    svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    let c1 = svc.commit(SCOPE, REQ_ID, &hash).unwrap();
    let c2 = svc.commit(SCOPE, REQ_ID, &hash).unwrap();
    assert_eq!(c1.main_storage_key, c2.main_storage_key);
    assert_eq!(c1.thumbnail_storage_key, c2.thumbnail_storage_key);
    assert_eq!(c2.state, IngestState::Published);
    let _ = root;
}

#[test]
fn commit_wrong_hash_conflicts() {
    let (svc, _root, bytes, hash) = svc_and_input();
    svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    let bad = super::canonical_request_hash(SCOPE, b"nope");
    let err = svc.commit(SCOPE, REQ_ID, &bad).unwrap_err();
    assert_eq!(err.code(), "MEDIA_INGEST_REQUEST_CONFLICT");
}

// ── abort ────────────────────────────────────────────────────────────────────

#[test]
fn abort_prepared_removes_temp() {
    let (svc, root, bytes, hash) = svc_and_input();
    svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    let r = svc.abort(SCOPE, REQ_ID).unwrap();
    assert_eq!(r.state, IngestState::Aborted);
    assert!(!temp_file(root.path(), SCOPE, REQ_ID, "main").exists());
    assert!(!temp_file(root.path(), SCOPE, REQ_ID, "thumb").exists());
    assert_eq!(
        load_j(root.path(), SCOPE, REQ_ID).state,
        IngestState::Aborted
    );
}

#[test]
fn abort_published_is_rejected_and_finals_remain() {
    let (svc, _root, bytes, hash) = svc_and_input();
    let p = svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    svc.commit(SCOPE, REQ_ID, &hash).unwrap();
    let err = svc.abort(SCOPE, REQ_ID).unwrap_err();
    assert_eq!(err.code(), "MEDIA_INGEST_ALREADY_PUBLISHED");
    // content-addressed finals still there
    assert!(svc.read(SCOPE, &p.main_descriptor.hash, "jpg").is_ok());
}

// ── recovery ─────────────────────────────────────────────────────────────────

#[test]
fn recovery_case_a_prepared_kept() {
    let (svc, root, bytes, hash) = svc_and_input();
    svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    let out = svc.recover().unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].to_state, IngestState::Prepared);
    assert_eq!(out[0].action, "kept_prepared");
    let _ = root;
}

#[test]
fn recovery_case_b_both_final_present() {
    let (svc, root, bytes, hash) = svc_and_input();
    svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    svc.commit(SCOPE, REQ_ID, &hash).unwrap();
    // simulate a crash right before the final journal write: back to publishing.
    let mut j = load_j(root.path(), SCOPE, REQ_ID);
    j.state = IngestState::Publishing;
    save_j(root.path(), &j);
    let out = svc.recover().unwrap();
    assert_eq!(out[0].to_state, IngestState::Published);
    assert_eq!(out[0].action, "repaired_published");
    // R3 direct contract: a successful recover on Publishing with both finals
    // present must durably converge the on-disk journal to Published — the
    // in-memory outcome above alone is not enough, the JSON on disk must
    // reflect the transition once recover returns Ok.
    let j = load_j(root.path(), SCOPE, REQ_ID);
    assert_eq!(j.state, IngestState::Published);
}

#[test]
fn recovery_case_c_publishes_missing_from_temp() {
    let (svc, root, bytes, hash) = svc_and_input();
    let p = svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    // publishing, only the MAIN final exists (thumb still just a temp)
    let mut j = load_j(root.path(), SCOPE, REQ_ID);
    j.state = IngestState::Publishing;
    save_j(root.path(), &j);
    let main_bytes = std::fs::read(temp_file(root.path(), SCOPE, REQ_ID, "main")).unwrap();
    super::super::storage::publish_atomically(
        root.path(),
        SCOPE,
        &main_bytes,
        &p.main_descriptor.hash,
        "jpg",
    )
    .unwrap();
    assert!(svc
        .read(SCOPE, &p.thumbnail_descriptor.hash, "jpg")
        .is_err()); // thumb absent pre-recovery
    let out = svc.recover().unwrap();
    assert_eq!(out[0].to_state, IngestState::Published);
    assert_eq!(out[0].action, "repaired_published_from_temp");
    assert!(svc.read(SCOPE, &p.thumbnail_descriptor.hash, "jpg").is_ok()); // now present
}

#[test]
fn recovery_case_d_missing_temp_and_final() {
    let (svc, root, bytes, hash) = svc_and_input();
    svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    let mut j = load_j(root.path(), SCOPE, REQ_ID);
    j.state = IngestState::Publishing;
    save_j(root.path(), &j);
    std::fs::remove_file(temp_file(root.path(), SCOPE, REQ_ID, "main")).unwrap();
    std::fs::remove_file(temp_file(root.path(), SCOPE, REQ_ID, "thumb")).unwrap();
    let out = svc.recover().unwrap();
    assert_eq!(out[0].to_state, IngestState::CleanupPending);
}

#[test]
fn recovery_case_e_wrong_final_quarantined_not_overwritten() {
    let (svc, root, bytes, hash) = svc_and_input();
    let p = svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    let mut j = load_j(root.path(), SCOPE, REQ_ID);
    j.state = IngestState::Publishing;
    save_j(root.path(), &j);
    // plant a FOREIGN file at the main final path
    let fp = final_file(root.path(), SCOPE, &p.main_descriptor.hash);
    std::fs::create_dir_all(fp.parent().unwrap()).unwrap();
    std::fs::write(&fp, b"foreign bytes at hash path").unwrap();
    let out = svc.recover().unwrap();
    assert_eq!(out[0].to_state, IngestState::Quarantined);
    assert_eq!(out[0].action, "quarantined_bad_final");
    assert_eq!(std::fs::read(&fp).unwrap(), b"foreign bytes at hash path");
}

#[test]
fn recovery_corrupt_journal_reported() {
    let (svc, root, bytes, hash) = svc_and_input();
    svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    std::fs::write(
        journal_file(root.path(), SCOPE, REQ_ID),
        b"{ not valid json",
    )
    .unwrap();
    let out = svc.recover().unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].action, "journal_corrupt");
    // and a direct commit surfaces the corrupt error code
    let err = svc.commit(SCOPE, REQ_ID, &hash).unwrap_err();
    assert_eq!(err.code(), "MEDIA_INGEST_JOURNAL_CORRUPT");
}

// ── durability / no path leaks / DTO contract ────────────────────────────────

#[test]
fn journal_update_is_atomic_no_tmp_leftover() {
    let (svc, root, bytes, hash) = svc_and_input();
    svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    svc.commit(SCOPE, REQ_ID, &hash).unwrap();
    // journal parses as complete JSON (never truncated)
    let j = load_j(root.path(), SCOPE, REQ_ID);
    assert_eq!(j.state, IngestState::Published);
    // no journal/temp write scratch files left behind
    let leftovers: Vec<String> = std::fs::read_dir(root.path().join(".ingest-journal"))
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".journal-tmp") || n.ends_with(".writing"))
        .collect();
    assert!(leftovers.is_empty(), "scratch files left: {leftovers:?}");
}

#[test]
fn dtos_carry_no_absolute_paths() {
    let (svc, root, bytes, hash) = svc_and_input();
    let p = svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    let c = svc.commit(SCOPE, REQ_ID, &hash).unwrap();
    let root_str = root.path().to_string_lossy().to_string();
    for json in [
        serde_json::to_string(&p).unwrap(),
        serde_json::to_string(&c).unwrap(),
    ] {
        assert!(!json.contains(&root_str), "DTO leaked the media root path");
        assert!(
            !json.contains(".ingest-journal"),
            "DTO leaked the journal dir"
        );
        assert!(!json.contains(".tmp"), "DTO leaked a temp key");
        assert!(
            !json.contains(":\\") && !json.contains(":/"),
            "DTO leaked an absolute path"
        );
    }
}

#[test]
fn dtos_serialize_round_trip() {
    let (svc, _root, bytes, hash) = svc_and_input();
    let p = svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    let json = serde_json::to_string(&p).unwrap();
    let back: PrepareResult = serde_json::from_str(&json).unwrap();
    assert_eq!(back.main_descriptor, p.main_descriptor);
    assert_eq!(back.state, IngestState::Prepared);
}

#[test]
fn stable_error_codes() {
    let (svc, _root, bytes, hash) = svc_and_input();
    // not found
    assert_eq!(
        svc.commit(SCOPE, REQ_ID, &hash).unwrap_err().code(),
        "MEDIA_INGEST_NOT_FOUND"
    );
    // invalid request (bad scope)
    assert_eq!(
        svc.prepare("bad/scope", REQ_ID, &hash, &bytes, None)
            .unwrap_err()
            .code(),
        "MEDIA_INGEST_INVALID_REQUEST"
    );
    // invalid request (bad request id)
    assert_eq!(
        svc.prepare(SCOPE, "short", &hash, &bytes, None)
            .unwrap_err()
            .code(),
        "MEDIA_INGEST_INVALID_REQUEST"
    );
    // invalid state: abort after publish is a different code (already published)
    svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    svc.commit(SCOPE, REQ_ID, &hash).unwrap();
    assert_eq!(
        svc.abort(SCOPE, REQ_ID).unwrap_err().code(),
        "MEDIA_INGEST_ALREADY_PUBLISHED"
    );
}

// ── IPC input ceiling (MAX_INGEST_INPUT_BYTES = 25 MiB) ──────────────────────

/// Bytes at exactly the limit must clear the IPC guard. They still fail
/// (25 MiB of zeros is not a decodable image), but with a *different* error
/// than the input-too-large rejection — proving the ceiling did not fire.
#[test]
fn ipc_input_at_limit_is_accepted_past_the_size_guard() {
    let root = TempRoot::new();
    let svc = MediaIngestService::new(root.path().to_path_buf());
    let bytes = vec![0u8; super::MAX_INGEST_INPUT_BYTES];
    let hash = super::canonical_request_hash(SCOPE, &bytes);
    let err = svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap_err();
    assert_ne!(err.code(), "MEDIA_INGEST_INPUT_TOO_LARGE");
}

/// One byte above the limit must be refused before any journal or temp file
/// touches the filesystem.
#[test]
fn ipc_input_over_limit_rejected_no_journal_no_temp() {
    let root = TempRoot::new();
    let svc = MediaIngestService::new(root.path().to_path_buf());
    let bytes = vec![0u8; super::MAX_INGEST_INPUT_BYTES + 1];
    let hash = super::canonical_request_hash(SCOPE, &bytes);
    let err = svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap_err();
    assert_eq!(err.code(), "MEDIA_INGEST_INPUT_TOO_LARGE");
    // Nothing may have landed on disk under the injected root.
    let dir = root.path().join(".ingest-journal");
    if dir.exists() {
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            leftovers.is_empty(),
            "rejected input left files behind: {leftovers:?}"
        );
    }
    assert!(!journal_file(root.path(), SCOPE, REQ_ID).exists());
    assert!(!temp_file(root.path(), SCOPE, REQ_ID, "main").exists());
    assert!(!temp_file(root.path(), SCOPE, REQ_ID, "thumb").exists());
}

// ── atomic replace via test-only write barrier ───────────────────────────────

/// An update aborted after the temp is synced but before the atomic rename
/// leaves the previous journal version intact — never a truncated JSON — and
/// leaves no scratch files behind.
#[test]
fn atomic_replace_barrier_keeps_previous_version_and_no_scratch() {
    let (svc, root, bytes, hash) = svc_and_input();
    svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();

    // Barrier fires between temp sync and rename; commit's first journal
    // update (Prepared → Publishing) must abort cleanly.
    svc.set_journal_write_barrier(Some(Arc::new(|| {
        Err(IngestError::Io("io:test-barrier".to_string()))
    })));
    let err = svc.commit(SCOPE, REQ_ID, &hash).unwrap_err();
    assert!(matches!(err, IngestError::Io(_)));

    // The old journal version is still Prepared, and it parses cleanly.
    let j = load_j(root.path(), SCOPE, REQ_ID);
    assert_eq!(j.state, IngestState::Prepared);

    // No `.journal-tmp` / `.creating` scratch left behind.
    let scratches: Vec<String> = std::fs::read_dir(root.path().join(".ingest-journal"))
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains(".journal-tmp") || n.contains(".creating"))
        .collect();
    assert!(scratches.is_empty(), "scratch left: {scratches:?}");

    // Remove the barrier and retry — the ingest surface is not poisoned.
    svc.set_journal_write_barrier(None);
    let c = svc.commit(SCOPE, REQ_ID, &hash).unwrap();
    assert_eq!(c.state, IngestState::Published);
}

/// The `create_journal_no_clobber` write path also honours the barrier: an
/// aborted first write must leave the media root free of a journal file so
/// a later retry can proceed.
#[test]
fn atomic_create_barrier_leaves_no_journal_file() {
    let root = TempRoot::new();
    let svc = MediaIngestService::new(root.path().to_path_buf());
    let bytes = png_bytes(320, 200);
    let hash = super::canonical_request_hash(SCOPE, &bytes);

    svc.set_journal_write_barrier(Some(Arc::new(|| {
        Err(IngestError::Io("io:test-barrier".to_string()))
    })));
    let err = svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap_err();
    assert!(matches!(err, IngestError::Io(_)));
    assert!(!journal_file(root.path(), SCOPE, REQ_ID).exists());

    svc.set_journal_write_barrier(None);
    let p = svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    assert_eq!(p.state, IngestState::Prepared);
}

// ── semantic journal validation ──────────────────────────────────────────────

fn overwrite_journal_at(path: &Path, j: &IngestJournal) {
    std::fs::write(path, serde_json::to_vec_pretty(j).unwrap()).unwrap();
}

#[test]
fn semantic_foreign_tenant_in_file_rejected() {
    let (svc, root, bytes, hash) = svc_and_input();
    svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    let mut j = load_j(root.path(), SCOPE, REQ_ID);
    j.tenant_scope = "tenant-x".to_string();
    overwrite_journal_at(&journal_file(root.path(), SCOPE, REQ_ID), &j);
    let err = svc.commit(SCOPE, REQ_ID, &hash).unwrap_err();
    assert_eq!(err.code(), "MEDIA_INGEST_JOURNAL_CORRUPT");
}

#[test]
fn semantic_wrong_request_id_in_file_rejected() {
    let (svc, root, bytes, hash) = svc_and_input();
    svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    let mut j = load_j(root.path(), SCOPE, REQ_ID);
    j.ingest_request_id = "22222222-2222-4222-8222-222222222222".to_string();
    overwrite_journal_at(&journal_file(root.path(), SCOPE, REQ_ID), &j);
    let err = svc.commit(SCOPE, REQ_ID, &hash).unwrap_err();
    assert_eq!(err.code(), "MEDIA_INGEST_JOURNAL_CORRUPT");
}

#[test]
fn semantic_path_traversal_in_temp_key_rejected() {
    let (svc, root, bytes, hash) = svc_and_input();
    svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    let mut j = load_j(root.path(), SCOPE, REQ_ID);
    j.main_temp_key = Some("../../etc/passwd".to_string());
    overwrite_journal_at(&journal_file(root.path(), SCOPE, REQ_ID), &j);
    let err = svc.commit(SCOPE, REQ_ID, &hash).unwrap_err();
    assert_eq!(err.code(), "MEDIA_INGEST_JOURNAL_CORRUPT");
    // Recovery must also refuse and quarantine — never follow the tampered key.
    let out = svc.recover().unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].action, "journal_corrupt");
}

#[test]
fn semantic_wrong_descriptor_hash_vs_storage_key_rejected() {
    let (svc, root, bytes, hash) = svc_and_input();
    svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    let mut j = load_j(root.path(), SCOPE, REQ_ID);
    // Mutate the descriptor hash so it no longer matches the storage_key.
    if let Some(d) = j.main_descriptor.as_mut() {
        d.hash = "0".repeat(64);
    }
    overwrite_journal_at(&journal_file(root.path(), SCOPE, REQ_ID), &j);
    let err = svc.commit(SCOPE, REQ_ID, &hash).unwrap_err();
    assert_eq!(err.code(), "MEDIA_INGEST_JOURNAL_CORRUPT");
}

#[test]
fn semantic_main_byte_size_over_limit_rejected() {
    let (svc, root, bytes, hash) = svc_and_input();
    svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    let mut j = load_j(root.path(), SCOPE, REQ_ID);
    if let Some(d) = j.main_descriptor.as_mut() {
        d.byte_size = 100_001;
    }
    overwrite_journal_at(&journal_file(root.path(), SCOPE, REQ_ID), &j);
    let err = svc.commit(SCOPE, REQ_ID, &hash).unwrap_err();
    assert_eq!(err.code(), "MEDIA_INGEST_JOURNAL_CORRUPT");
}

#[test]
fn semantic_preparing_with_payload_rejected() {
    let (svc, root, bytes, hash) = svc_and_input();
    svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    // Craft an illegal combination: state=Preparing must NOT carry a descriptor
    // or storage_key — those are only set once the payload write flips to
    // Prepared. Tampering here is a hard corrupt signal.
    let mut j = load_j(root.path(), SCOPE, REQ_ID);
    j.state = IngestState::Preparing;
    // Leave main_descriptor Some (carried over from the real Prepared write).
    overwrite_journal_at(&journal_file(root.path(), SCOPE, REQ_ID), &j);
    let err = svc.commit(SCOPE, REQ_ID, &hash).unwrap_err();
    assert_eq!(err.code(), "MEDIA_INGEST_JOURNAL_CORRUPT");
}

// ── concurrency: prepare races ───────────────────────────────────────────────

/// Twenty parallel prepares of the identical request must produce exactly one
/// journal file and hand every caller the same frozen PrepareResult.
#[test]
fn parallel_prepare_same_hash_yields_one_journal() {
    let root = TempRoot::new();
    let svc = Arc::new(MediaIngestService::new(root.path().to_path_buf()));
    let bytes = png_bytes(320, 200);
    let hash = super::canonical_request_hash(SCOPE, &bytes);

    let mut handles = Vec::with_capacity(20);
    for _ in 0..20 {
        let s = svc.clone();
        let b = bytes.clone();
        let h = hash.clone();
        handles.push(std::thread::spawn(move || {
            s.prepare(SCOPE, REQ_ID, &h, &b, None)
        }));
    }
    let results: Vec<Result<PrepareResult, IngestError>> =
        handles.into_iter().map(|h| h.join().unwrap()).collect();

    let first = results[0].clone().expect("at least one must succeed");
    for r in &results {
        let r = r.as_ref().expect("all 20 must succeed for the same hash");
        assert_eq!(r.state, IngestState::Prepared);
        assert_eq!(r.main_descriptor, first.main_descriptor);
        assert_eq!(r.thumbnail_descriptor, first.thumbnail_descriptor);
    }
    // Exactly one journal file for the identity.
    let journals: Vec<String> = std::fs::read_dir(root.path().join(".ingest-journal"))
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !n.starts_with('.') && n.ends_with(".json"))
        .collect();
    assert_eq!(journals.len(), 1, "unexpected journals: {journals:?}");
}

/// Two parallel prepares of the *same* identity with *different* hashes must
/// leave exactly one journal (the winner's) and the loser must observe a
/// hard `REQUEST_CONFLICT` — the file is never overwritten.
#[test]
fn parallel_prepare_different_hashes_one_wins_journal_not_overwritten() {
    let root = TempRoot::new();
    let svc = Arc::new(MediaIngestService::new(root.path().to_path_buf()));
    let bytes_a = png_bytes(320, 200);
    let bytes_b = png_bytes(200, 320);
    let hash_a = super::canonical_request_hash(SCOPE, &bytes_a);
    let hash_b = super::canonical_request_hash(SCOPE, &bytes_b);
    assert_ne!(hash_a, hash_b);

    let s1 = svc.clone();
    let s2 = svc.clone();
    let ha = hash_a.clone();
    let hb = hash_b.clone();
    let t1 = std::thread::spawn(move || s1.prepare(SCOPE, REQ_ID, &ha, &bytes_a, None));
    let t2 = std::thread::spawn(move || s2.prepare(SCOPE, REQ_ID, &hb, &bytes_b, None));
    let r1 = t1.join().unwrap();
    let r2 = t2.join().unwrap();

    let (winner, loser) = match (r1, r2) {
        (Ok(w), Err(l)) => (w, l),
        (Err(l), Ok(w)) => (w, l),
        (r1, r2) => panic!("expected exactly one Ok and one Err: {r1:?} / {r2:?}"),
    };
    assert_eq!(loser.code(), "MEDIA_INGEST_REQUEST_CONFLICT");

    // The on-disk journal must carry the winner's hash, never the loser's.
    let j = load_j(root.path(), SCOPE, REQ_ID);
    assert_eq!(j.request_hash, winner.request_hash);
}

/// commit and abort racing on the same prepared journal must resolve to
/// exactly one terminal outcome — either published or aborted — and never
/// both nor neither.
#[test]
fn parallel_commit_vs_abort_resolves_to_one_terminal_state() {
    let (svc, root, bytes, hash) = svc_and_input();
    svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    let svc = Arc::new(svc);
    let s1 = svc.clone();
    let s2 = svc.clone();
    let hc = hash.clone();
    let t1 = std::thread::spawn(move || s1.commit(SCOPE, REQ_ID, &hc));
    let t2 = std::thread::spawn(move || s2.abort(SCOPE, REQ_ID));
    let r1 = t1.join().unwrap();
    let r2 = t2.join().unwrap();

    let successes = r1.is_ok() as u8 + r2.is_ok() as u8;
    assert_eq!(
        successes, 1,
        "exactly one operation must win: commit={r1:?}, abort={r2:?}"
    );
    let j = load_j(root.path(), SCOPE, REQ_ID);
    assert!(
        matches!(j.state, IngestState::Published | IngestState::Aborted),
        "unexpected terminal state: {:?}",
        j.state
    );
}

/// commit and recover racing must not corrupt the journal or produce a
/// duplicate. The commit succeeds; recovery reports a final state consistent
/// with the completed operation.
#[test]
fn parallel_commit_vs_recovery_do_not_corrupt_journal() {
    let (svc, root, bytes, hash) = svc_and_input();
    svc.prepare(SCOPE, REQ_ID, &hash, &bytes, None).unwrap();
    let svc = Arc::new(svc);
    let s1 = svc.clone();
    let s2 = svc.clone();
    let hc = hash.clone();
    let t1 = std::thread::spawn(move || s1.commit(SCOPE, REQ_ID, &hc));
    let t2 = std::thread::spawn(move || s2.recover());
    let r1 = t1.join().unwrap();
    let r2 = t2.join().unwrap();
    assert!(r1.is_ok(), "commit must succeed: {r1:?}");
    assert!(r2.is_ok(), "recover must succeed: {r2:?}");
    let j = load_j(root.path(), SCOPE, REQ_ID);
    assert!(
        matches!(j.state, IngestState::Published | IngestState::Publishing),
        "unexpected state after race: {:?}",
        j.state
    );
    // A follow-up commit converges to Published.
    let c = svc.commit(SCOPE, REQ_ID, &hash).unwrap();
    assert_eq!(c.state, IngestState::Published);
}

// ── command-level races on the *shared* coordinator ──────────────────────────
//
// These tests model the desktop app's actual command topology: exactly one
// `MediaIngestService` lives in Tauri-managed state, and every `#[tauri::command]`
// handler clones the same `Arc` — mirrored here by the `Coord` alias plus
// `handle_*` closures whose bodies match the real command handlers in `lib.rs`
// verbatim (minus the `tauri::State` shell).
//
// A frank baseline (`separately_constructed_services_do_not_share_locks`)
// proves why the shared coordinator matters: two independently-built services
// against the same media root do *not* observe each other's identity locks.

type Coord = Arc<MediaIngestService>;

fn handle_prepare(
    svc: &Coord,
    scope: &str,
    id: &str,
    hash: &str,
    bytes: &[u8],
) -> Result<PrepareResult, IngestError> {
    svc.prepare(scope, id, hash, bytes, None)
}
fn handle_commit(
    svc: &Coord,
    scope: &str,
    id: &str,
    hash: &str,
) -> Result<CommitResult, IngestError> {
    svc.commit(scope, id, hash)
}
fn handle_abort(svc: &Coord, scope: &str, id: &str) -> Result<AbortResult, IngestError> {
    svc.abort(scope, id)
}
fn handle_recover(svc: &Coord) -> Result<Vec<RecoveryOutcome>, IngestError> {
    svc.recover()
}

#[test]
fn separately_constructed_services_do_not_share_locks() {
    // Documents the negative baseline that motivates the shared coordinator:
    // building two `MediaIngestService`s against the same media root produces
    // two independent identity_locks maps.
    let root = TempRoot::new();
    let a = MediaIngestService::new(root.path().to_path_buf());
    let b = MediaIngestService::new(root.path().to_path_buf());
    let la = a.identity_lock(SCOPE, REQ_ID);
    let lb = b.identity_lock(SCOPE, REQ_ID);
    assert!(
        !Arc::ptr_eq(&la, &lb),
        "distinct services must not share a lock"
    );
    assert_eq!(a.active_identity_lock_count(), 1);
    assert_eq!(b.active_identity_lock_count(), 1);
    drop(la);
    drop(lb);
    // Hold fresh Arcs so the registry retains a *live* entry each — the GC
    // path fires opportunistically on every identity_lock call, so the old
    // dead entries are pruned by the very act of asking for a new one.
    let _hold_a = a.identity_lock(SCOPE, "22222222-2222-4222-8222-222222222222");
    let _hold_b = b.identity_lock(SCOPE, "22222222-2222-4222-8222-222222222222");
    assert_eq!(a.active_identity_lock_count(), 1);
    assert_eq!(b.active_identity_lock_count(), 1);
}

#[test]
fn shared_coordinator_hands_out_same_lock_for_identity() {
    let root = TempRoot::new();
    let coord: Coord = Arc::new(MediaIngestService::new(root.path().to_path_buf()));
    let a = coord.identity_lock(SCOPE, REQ_ID);
    let b = coord.identity_lock(SCOPE, REQ_ID);
    assert!(Arc::ptr_eq(&a, &b), "same identity must map to same Arc");
    let c = coord.identity_lock(SCOPE, "22222222-2222-4222-8222-222222222222");
    assert!(
        !Arc::ptr_eq(&a, &c),
        "different identities must map to different Arcs"
    );
}

/// Twenty parallel prepare-command invocations against the shared coordinator
/// must produce exactly one journal and hand every handler the same frozen
/// PrepareResult; the identity_locks registry must return to zero after all
/// operations complete.
#[test]
fn command_race_20_parallel_prepares_on_shared_coordinator() {
    let root = TempRoot::new();
    let coord: Coord = Arc::new(MediaIngestService::new(root.path().to_path_buf()));
    let bytes = png_bytes(320, 200);
    let hash = super::canonical_request_hash(SCOPE, &bytes);

    let mut handles = Vec::with_capacity(20);
    for _ in 0..20 {
        // Every "handler" clones the shared coordinator, exactly as the real
        // Tauri command handler does with `state.media_ingest.clone()`.
        let c = coord.clone();
        let b = bytes.clone();
        let h = hash.clone();
        handles.push(std::thread::spawn(move || {
            handle_prepare(&c, SCOPE, REQ_ID, &h, &b)
        }));
    }
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let first = results[0].clone().expect("at least one prepare succeeds");
    for r in &results {
        let r = r.as_ref().expect("all 20 must succeed on the same hash");
        assert_eq!(r.main_descriptor, first.main_descriptor);
        assert_eq!(r.thumbnail_descriptor, first.thumbnail_descriptor);
    }
    let journals: Vec<String> = std::fs::read_dir(root.path().join(".ingest-journal"))
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !n.starts_with('.') && n.ends_with(".json"))
        .collect();
    assert_eq!(journals.len(), 1, "unexpected journals: {journals:?}");
    // After every handler returned, no identity lock stays alive.
    assert_eq!(
        coord.active_identity_lock_count(),
        0,
        "identity_locks did not shrink back to zero"
    );
}

/// commit-command vs abort-command racing on the same prepared journal — two
/// handlers, both fetched via `state.media_ingest.clone()` — must resolve to
/// exactly one terminal outcome, and the registry must free the lock after.
#[test]
fn command_race_commit_vs_abort_on_shared_coordinator() {
    let root = TempRoot::new();
    let coord: Coord = Arc::new(MediaIngestService::new(root.path().to_path_buf()));
    let bytes = png_bytes(320, 200);
    let hash = super::canonical_request_hash(SCOPE, &bytes);
    handle_prepare(&coord, SCOPE, REQ_ID, &hash, &bytes).unwrap();

    let c1 = coord.clone();
    let c2 = coord.clone();
    let hc = hash.clone();
    let t1 = std::thread::spawn(move || handle_commit(&c1, SCOPE, REQ_ID, &hc));
    let t2 = std::thread::spawn(move || handle_abort(&c2, SCOPE, REQ_ID));
    let r1 = t1.join().unwrap();
    let r2 = t2.join().unwrap();

    assert_eq!(
        (r1.is_ok() as u8) + (r2.is_ok() as u8),
        1,
        "exactly one command wins: commit={r1:?}, abort={r2:?}"
    );
    let j = load_j(root.path(), SCOPE, REQ_ID);
    assert!(matches!(
        j.state,
        IngestState::Published | IngestState::Aborted
    ));
    assert_eq!(
        coord.active_identity_lock_count(),
        0,
        "lock must be released after both handlers finish"
    );
}

/// commit-command vs recover-command racing on the shared coordinator must
/// converge to a single, consistent Published journal. Because the two
/// handlers serialise through the same identity lock, exactly one of two
/// interleavings is possible — recover-first sees Prepared and keeps it (no
/// state change), then commit drives Prepared → Publishing → Published; or
/// commit-first drives Prepared → Publishing → Published, then recover sees
/// Published and reports it as such. In both interleavings `commit` only
/// returns `Ok` after the Published write is durable and both temp files
/// are removed. There is no legal outcome in which both handlers succeed
/// and Publishing is left behind.
#[test]
fn command_race_commit_vs_recover_converges_to_published() {
    let root = TempRoot::new();
    let coord: Coord = Arc::new(MediaIngestService::new(root.path().to_path_buf()));
    let bytes = png_bytes(320, 200);
    let hash = super::canonical_request_hash(SCOPE, &bytes);
    let p = handle_prepare(&coord, SCOPE, REQ_ID, &hash, &bytes).unwrap();

    let c1 = coord.clone();
    let c2 = coord.clone();
    let hc = hash.clone();
    let t1 = std::thread::spawn(move || handle_commit(&c1, SCOPE, REQ_ID, &hc));
    let t2 = std::thread::spawn(move || handle_recover(&c2));
    let r1 = t1.join().unwrap();
    let r2 = t2.join().unwrap();
    assert!(r1.is_ok(), "commit failed: {r1:?}");
    assert!(r2.is_ok(), "recover failed: {r2:?}");

    // Journal MUST be Published on disk — Publishing is not a legal outcome
    // when both handlers report Ok.
    let j = load_j(root.path(), SCOPE, REQ_ID);
    assert_eq!(
        j.state,
        IngestState::Published,
        "both handlers Ok must imply Published; got {:?}",
        j.state
    );
    // Both content-addressed finals must be readable through the core.
    coord
        .read(SCOPE, &p.main_descriptor.hash, "jpg")
        .expect("main final not readable after successful commit+recover");
    coord
        .read(SCOPE, &p.thumbnail_descriptor.hash, "jpg")
        .expect("thumb final not readable after successful commit+recover");
    // No temp/scratch files must linger in the journal dir.
    let leftovers: Vec<String> = std::fs::read_dir(root.path().join(".ingest-journal"))
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| {
            n.ends_with(".jpg.tmp") || n.contains(".journal-tmp") || n.contains(".creating")
        })
        .collect();
    assert!(
        leftovers.is_empty(),
        "unexpected leftovers after commit+recover: {leftovers:?}"
    );
    assert_eq!(
        coord.active_identity_lock_count(),
        0,
        "lock must be released after both handlers finish"
    );
}

/// Different identities must not block each other: two prepare-commands on
/// disjoint `(scope, id)` pairs run truly in parallel and each spawns its
/// own lock, both of which are released afterwards.
#[test]
fn command_race_different_identities_do_not_block_each_other() {
    let root = TempRoot::new();
    let coord: Coord = Arc::new(MediaIngestService::new(root.path().to_path_buf()));
    let bytes = png_bytes(320, 200);
    let hash = super::canonical_request_hash(SCOPE, &bytes);
    let id_a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let id_b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let c1 = coord.clone();
    let c2 = coord.clone();
    let ba = bytes.clone();
    let bb = bytes.clone();
    let ha = hash.clone();
    let hb = hash.clone();
    let t1 = std::thread::spawn(move || handle_prepare(&c1, SCOPE, id_a, &ha, &ba));
    let t2 = std::thread::spawn(move || handle_prepare(&c2, SCOPE, id_b, &hb, &bb));
    let r1 = t1.join().unwrap();
    let r2 = t2.join().unwrap();
    assert!(r1.is_ok() && r2.is_ok());
    assert_eq!(
        coord.active_identity_lock_count(),
        0,
        "registry must release both identity locks"
    );
}

/// Lock-registry cleanup: after many completed operations, the number of
/// live identity locks is proportional to *currently in-flight* identities
/// (zero here), not to the total number ever seen.
#[test]
fn lock_registry_shrinks_back_to_zero_after_operations_complete() {
    let root = TempRoot::new();
    let coord: Coord = Arc::new(MediaIngestService::new(root.path().to_path_buf()));
    let bytes = png_bytes(320, 200);
    let hash = super::canonical_request_hash(SCOPE, &bytes);
    let ids = [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    ];
    for id in ids {
        handle_prepare(&coord, SCOPE, id, &hash, &bytes).unwrap();
    }
    assert_eq!(
        coord.active_identity_lock_count(),
        0,
        "all identity locks must be released once prepares return"
    );
}
