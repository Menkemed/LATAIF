//! MEDIA-04B2A12-I2 — REAL host proof for the backup snapshot: real temp files, real WAL checkpoint,
//! real symlink/containment/hash safety (via read_verified_media), real atomic directory publish.

use super::*;
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn tmp() -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!(
        "a12-backup-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Write a content-addressed jpg under the media root and return (hash, byte_size).
fn put_media(root: &std::path::Path, scope: &str, bytes: &[u8]) -> (String, u64) {
    let hash = sha256_hex(bytes);
    let rel = format!("{}/{}/{}.jpg", scope, &hash[0..2], hash);
    let abs = root.join(&rel);
    std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
    std::fs::write(&abs, bytes).unwrap();
    (hash, bytes.len() as u64)
}

fn sel(scope: &str, hash: &str, size: u64, variant: Option<&str>) -> MediaSelection {
    MediaSelection {
        scope: scope.into(),
        hash: hash.into(),
        extension: "jpg".into(),
        byte_size: size,
        media_id: "media-1".into(),
        generation_no: 1,
        variant_type: variant.map(|v| v.into()),
        role: variant.map(|_| "variant").unwrap_or("stock_image").into(),
    }
}

fn make_dbs(base: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let front = base.join("lataif.db");
    std::fs::write(&front, b"FRONTEND-DB-BYTES").unwrap();
    // a real SQLite server DB so the WAL checkpoint runs against a real connection
    let server = base.join("lataif_sync_server.db");
    let conn = rusqlite::Connection::open(&server).unwrap();
    conn.execute_batch("CREATE TABLE t(x); INSERT INTO t VALUES(1);").unwrap();
    drop(conn);
    (front, server)
}

struct Layout {
    base: std::path::PathBuf,
    root: std::path::PathBuf,
    front: std::path::PathBuf,
    server: std::path::PathBuf,
    out: std::path::PathBuf,
    ws_parent: std::path::PathBuf,
}
fn layout() -> Layout {
    let base = tmp();
    let root = base.join("media");
    std::fs::create_dir_all(&root).unwrap();
    let (front, server) = make_dbs(&base);
    Layout {
        out: base.join("backup-final"),
        ws_parent: base.clone(),
        root,
        front,
        server,
        base,
    }
}
fn input<'a>(l: &'a Layout, selection: &'a [MediaSelection]) -> SnapshotInput<'a> {
    SnapshotInput {
        media_root: &l.root,
        frontend_db: &l.front,
        server_db: Some(&l.server),
        selection,
        created_at: "2026-07-30T00:00:00Z".into(),
        app_version: "0.8.23".into(),
        schema_version: "s1".into(),
        media_schema_version: "m1".into(),
        out_dir: &l.out,
        workspace_parent: &l.ws_parent,
    }
}

#[test]
fn collect_selection_returns_master_and_thumbnail_variant() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE media_links(tenant_id,media_id,media_role,deleted_at);
         CREATE TABLE media_objects(tenant_id,media_id,master_blob_id,deleted_at);
         CREATE TABLE media_blobs(tenant_id,blob_id,blob_status,current_generation_no);
         CREATE TABLE media_blob_generations(tenant_id,blob_id,generation_no,gen_status,storage_key,stored_blob_hash,byte_size,extension);
         CREATE TABLE media_variants(tenant_id,variant_id,media_id,variant_type,blob_id,deleted_at);
         CREATE TABLE media_ingest_jobs(tenant_id,target_media_id,target_blob_id,state);
         INSERT INTO media_links VALUES('t','m','stock_image',NULL);
         INSERT INTO media_objects VALUES('t','m','bm',NULL);
         INSERT INTO media_blobs VALUES('t','bm','present',1);
         INSERT INTO media_blob_generations VALUES('t','bm',1,'available','t/aa/aa.jpg','aa',10,'jpg');
         INSERT INTO media_variants VALUES('t','v','m','thumbnail','bt',NULL);
         INSERT INTO media_blobs VALUES('t','bt','present',1);
         INSERT INTO media_blob_generations VALUES('t','bt',1,'available','t/bb/bb.jpg','bb',5,'jpg');",
    )
    .unwrap();
    let sel = collect_selection_from_db(&conn).unwrap();
    assert_eq!(sel.len(), 2, "master + thumbnail variant selected");
    assert!(sel.iter().any(|s| s.variant_type.is_none() && s.role == "stock_image"), "master present");
    assert!(sel.iter().any(|s| s.variant_type.as_deref() == Some("thumbnail") && s.role == "variant"), "thumbnail variant present");
}

#[test]
fn happy_path_publishes_complete_manifest_with_all_media_and_hashes() {
    let l = layout();
    let scope = "tenant-1";
    let (mh, ms) = put_media(&l.root, scope, b"MASTER-IMAGE-BYTES");
    let (th, ts) = put_media(&l.root, scope, b"THUMB-BYTES");
    let selection = vec![sel(scope, &mh, ms, None), sel(scope, &th, ts, Some("thumbnail"))];
    let m = snapshot(&input(&l, &selection)).expect("snapshot ok");

    assert_eq!(m.status, "complete");
    assert_eq!(m.file_count, 2);
    assert_eq!(m.additional_db_files.len(), 1);
    // published files exist
    assert!(l.out.join("lataif.db").exists());
    assert!(l.out.join("lataif_sync_server.db").exists());
    assert!(l.out.join("manifest.json").exists());
    for f in &m.files {
        let p = l.out.join(&f.rel_path);
        assert!(p.exists(), "media file published");
        assert_eq!(sha256_hex(&std::fs::read(&p).unwrap()), f.hash, "copied bytes hash to content address");
    }
    // DB hash recorded correctly
    assert_eq!(m.db.sha256, sha256_hex(&std::fs::read(l.out.join("lataif.db")).unwrap()));
}

#[test]
fn missing_media_file_fails_closed_nothing_published() {
    let l = layout();
    let scope = "tenant-1";
    let (mh, ms) = put_media(&l.root, scope, b"MASTER-IMAGE-BYTES");
    // selection references a hash whose file was never written
    let ghost = sha256_hex(b"NEVER-WRITTEN");
    let selection = vec![sel(scope, &mh, ms, None), sel(scope, &ghost, 5, None)];
    let err = snapshot(&input(&l, &selection)).unwrap_err();
    assert_eq!(err.code(), "MEDIA_FILE_MISSING");
    assert!(!l.out.exists(), "nothing published");
}

#[test]
fn corrupted_media_file_fails_closed() {
    let l = layout();
    let scope = "tenant-1";
    let (mh, ms) = put_media(&l.root, scope, b"MASTER-IMAGE-BYTES");
    // overwrite the on-disk bytes so they no longer hash to the content address
    let rel = format!("{}/{}/{}.jpg", scope, &mh[0..2], mh);
    std::fs::write(l.root.join(&rel), b"TAMPERED-DIFFERENT-BYTES").unwrap();
    let selection = vec![sel(scope, &mh, ms, None)];
    let err = snapshot(&input(&l, &selection)).unwrap_err();
    assert_eq!(err.code(), "MEDIA_FILE_HASH_MISMATCH");
    assert!(!l.out.exists(), "nothing published");
}

#[test]
fn path_traversal_scope_fails_closed() {
    let l = layout();
    let (mh, ms) = put_media(&l.root, "tenant-1", b"MASTER-IMAGE-BYTES");
    // a scope that tries to escape the media root
    let selection = vec![sel("../evil", &mh, ms, None)];
    let err = snapshot(&input(&l, &selection)).unwrap_err();
    assert!(matches!(err, MediaError::PathOutsideRoot), "traversal rejected: {:?}", err);
    assert!(!l.out.exists(), "nothing published");
}

#[cfg(windows)]
#[test]
fn symlinked_media_file_fails_closed_if_perm() {
    let l = layout();
    let scope = "tenant-1";
    let (target_h, _) = put_media(&l.root, scope, b"REAL-TARGET-BYTES");
    // claim a DIFFERENT content address whose path is a symlink to the real file
    let fake = sha256_hex(b"CLAIMED-BYTES");
    let rel = format!("{}/{}/{}.jpg", scope, &fake[0..2], fake);
    let link = l.root.join(&rel);
    std::fs::create_dir_all(link.parent().unwrap()).unwrap();
    let target = l.root.join(format!("{}/{}/{}.jpg", scope, &target_h[0..2], target_h));
    if std::os::windows::fs::symlink_file(&target, &link).is_err() {
        return; // no symlink privilege in this environment — covered by the JS §A + resolve safety
    }
    let selection = vec![sel(scope, &fake, 12, None)];
    let err = snapshot(&input(&l, &selection)).unwrap_err();
    assert_eq!(err.code(), "MEDIA_PATH_REPARSE_POINT_FORBIDDEN", "symlink/reparse rejected: {:?}", err);
    assert!(!l.out.exists(), "nothing published");
}
