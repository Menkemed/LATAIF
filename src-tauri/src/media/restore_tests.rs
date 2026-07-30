//! MEDIA-04B2A12-R1 — REAL restore proof: real backup dir, full pre-check fail-closed, atomic swap,
//! hash-identical restore, rollback on a simulated mid-swap failure, and post-restore integrity.

use super::*;
use crate::media::backup;
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);
fn tmp() -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("a12r-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
    std::fs::create_dir_all(&d).unwrap();
    d
}
fn put_media(root: &std::path::Path, scope: &str, bytes: &[u8]) -> String {
    let h = sha256_hex(bytes);
    let abs = root.join(format!("{}/{}/{}.jpg", scope, &h[0..2], h));
    std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
    std::fs::write(&abs, bytes).unwrap();
    h
}
/// Build a live app_data_dir: lataif.db (one link → master + thumbnail variant) + media files + server DB.
fn build_live(base: &std::path::Path, master: &[u8], thumb: &[u8]) {
    let media = base.join("media");
    std::fs::create_dir_all(&media).unwrap();
    let mh = put_media(&media, "t", master);
    let th = put_media(&media, "t", thumb);
    let front = base.join("lataif.db");
    let c = rusqlite::Connection::open(&front).unwrap();
    c.execute_batch(&format!(
        "CREATE TABLE media_links(tenant_id,media_id,media_role,deleted_at);
         CREATE TABLE media_objects(tenant_id,media_id,master_blob_id,deleted_at);
         CREATE TABLE media_blobs(tenant_id,blob_id,blob_status,current_generation_no);
         CREATE TABLE media_blob_generations(tenant_id,blob_id,generation_no,gen_status,storage_key,stored_blob_hash,byte_size,extension);
         CREATE TABLE media_variants(tenant_id,variant_id,media_id,variant_type,blob_id,deleted_at);
         CREATE TABLE media_ingest_jobs(tenant_id,target_media_id,target_blob_id,state);
         INSERT INTO media_links VALUES('t','m','stock_image',NULL);
         INSERT INTO media_objects VALUES('t','m','bm',NULL);
         INSERT INTO media_blobs VALUES('t','bm','present',1);
         INSERT INTO media_blob_generations VALUES('t','bm',1,'available','t/{ma}/{mh}.jpg','{mh}',{ms},'jpg');
         INSERT INTO media_variants VALUES('t','v','m','thumbnail','bt',NULL);
         INSERT INTO media_blobs VALUES('t','bt','present',1);
         INSERT INTO media_blob_generations VALUES('t','bt',1,'available','t/{ta}/{th}.jpg','{th}',{ts},'jpg');",
        ma = &mh[0..2], mh = mh, ms = master.len(), ta = &th[0..2], th = th, ts = thumb.len()
    )).unwrap();
    drop(c);
    let server = base.join("lataif_sync_server.db");
    let sc = rusqlite::Connection::open(&server).unwrap();
    sc.execute_batch("CREATE TABLE s(x); INSERT INTO s VALUES(1);").unwrap();
    drop(sc);
}
fn make_backup(live: &std::path::Path, out: &std::path::Path, ws_parent: &std::path::Path) -> backup::BackupManifest {
    let front = live.join("lataif.db");
    let conn = rusqlite::Connection::open(&front).unwrap();
    let selection = backup::collect_selection_from_db(&conn).unwrap();
    drop(conn);
    let server = live.join("lataif_sync_server.db");
    let input = backup::SnapshotInput {
        media_root: &live.join("media"), frontend_db: &front, server_db: Some(&server), selection: &selection,
        created_at: "2026-07-30T00:00:00Z".into(), app_version: "e2e".into(), schema_version: "s1".into(),
        media_schema_version: "m1".into(), out_dir: out, workspace_parent: ws_parent,
    };
    backup::snapshot(&input).unwrap()
}
fn dir_hashes(base: &std::path::Path) -> std::collections::BTreeMap<String, String> {
    let mut out = std::collections::BTreeMap::new();
    let mut stack = vec![base.to_path_buf()];
    while let Some(d) = stack.pop() {
        if !d.exists() { continue; }
        for e in std::fs::read_dir(&d).unwrap() {
            let p = e.unwrap().path();
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            if name.starts_with(".restore-") { continue; }
            if p.is_dir() { stack.push(p); continue; }
            let rel = p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
            out.insert(rel, sha256_hex(&std::fs::read(&p).unwrap()));
        }
    }
    out
}

#[test]
fn precheck_passes_for_a_real_complete_backup() {
    let b = tmp();
    let live = b.join("live"); std::fs::create_dir_all(&live).unwrap();
    build_live(&live, b"MASTER", b"THUMB");
    let out = b.join("backup"); make_backup(&live, &out, &b);
    let m = validate_snapshot(&out).expect("validate ok");
    assert_eq!(m.status, "complete");
    assert_eq!(m.files.len(), 2);
}

#[test]
fn precheck_fails_closed_on_corrupt_missing_extra_incomplete() {
    let b = tmp();
    let live = b.join("live"); std::fs::create_dir_all(&live).unwrap();
    build_live(&live, b"MASTER", b"THUMB");
    // corrupt a media file
    let out1 = b.join("bk1"); let m1 = make_backup(&live, &out1, &b);
    std::fs::write(out1.join(&m1.files[0].rel_path), b"TAMPERED").unwrap();
    assert_eq!(validate_snapshot(&out1).unwrap_err().code(), "MEDIA_FILE_HASH_MISMATCH");
    // missing a media file
    let out2 = b.join("bk2"); let m2 = make_backup(&live, &out2, &b);
    std::fs::remove_file(out2.join(&m2.files[0].rel_path)).unwrap();
    assert_eq!(validate_snapshot(&out2).unwrap_err().code(), "MEDIA_FILE_MISSING");
    // an unexpected extra file
    let out3 = b.join("bk3"); make_backup(&live, &out3, &b);
    std::fs::write(out3.join("EXTRA_UNLISTED.dat"), b"x").unwrap();
    assert_eq!(validate_snapshot(&out3).unwrap_err().code(), "MEDIA_RESTORE_UNEXPECTED_FILE");
    // incomplete status
    let out4 = b.join("bk4"); make_backup(&live, &out4, &b);
    let raw = std::fs::read_to_string(out4.join("manifest.json")).unwrap().replace("\"complete\"", "\"in_progress\"");
    std::fs::write(out4.join("manifest.json"), raw).unwrap();
    assert_eq!(validate_snapshot(&out4).unwrap_err().code(), "MEDIA_RESTORE_INCOMPLETE_BACKUP");
}

#[test]
fn atomic_restore_recovers_the_exact_prior_state() {
    let b = tmp();
    let src = b.join("src"); std::fs::create_dir_all(&src).unwrap();
    build_live(&src, b"ORIGINAL-MASTER", b"ORIGINAL-THUMB");
    let backup = b.join("backup"); make_backup(&src, &backup, &b);
    let want = dir_hashes(&src);

    // a DIFFERENT live tree to restore INTO
    let live = b.join("live"); std::fs::create_dir_all(&live).unwrap();
    build_live(&live, b"WRONG-MASTER-DATA", b"WRONG-THUMB-DATA");
    assert_ne!(dir_hashes(&live), want, "live differs before restore");

    let m = restore(&RestoreInput { backup_dir: &backup, app_data_dir: &live }, false).expect("restore ok");
    assert_eq!(m.status, "complete");
    // hash-identical to the original source (DB + both media files + server DB)
    assert_eq!(dir_hashes(&live), want, "restored tree is hash-identical to the original");
    // post-restore integrity: every gallery ref resolves
    assert_eq!(verify_restored(&live, &m).unwrap(), 2, "master + thumbnail resolvable after restore");
    // no leftover staging/rollback/journal
    assert!(!live.join(".restore-staging").exists() && !live.join(".restore-rollback").exists() && !live.join(".restore-journal").exists());
}

#[test]
fn crash_after_every_journal_and_swap_step_recovers_to_the_exact_prior_state() {
    for crash in [CrashAt::AsideJournalled, CrashAt::MovedAside, CrashAt::SwapJournalled, CrashAt::SwappedIn] {
        let b = tmp();
        let src = b.join("src"); std::fs::create_dir_all(&src).unwrap();
        build_live(&src, b"BACKUP-MASTER", b"BACKUP-THUMB");
        let backup = b.join("backup"); make_backup(&src, &backup, &b);
        let backup_before = dir_hashes(&backup);

        let live = b.join("live"); std::fs::create_dir_all(&live).unwrap();
        build_live(&live, b"CURRENT-MASTER", b"CURRENT-THUMB");
        let prior = dir_hashes(&live);

        // simulate a hard crash right after this journal/swap step (no in-process rollback/cleanup)
        let err = restore_crashing(&RestoreInput { backup_dir: &backup, app_data_dir: &live }, crash).unwrap_err();
        assert!(matches!(err, MediaError::Io(_)), "{:?}: crash surfaced", crash);
        // a crash journal + partial on-disk state exists
        assert!(live.join(".restore-journal").exists(), "{:?}: journal present after crash", crash);

        // restart → recover() reconciles to the OLD state (pre-commit), never a mixed stand
        recover(&live).unwrap();
        assert_eq!(dir_hashes(&live), prior, "{:?}: recovered to the exact prior state", crash);
        assert!(!live.join(".restore-staging").exists() && !live.join(".restore-rollback").exists() && !live.join(".restore-journal").exists(), "{:?}: journal/temp cleaned", crash);
        // the backup SOURCE was never modified
        assert_eq!(dir_hashes(&backup), backup_before, "{:?}: backup source untouched", crash);
    }
}

#[test]
fn boot_recover_fails_closed_on_unrecoverable_journal_and_cleans_committed() {
    use crate::media::restore_recovery;
    // no journal → Ok, no-op
    let a = tmp(); assert!(recover(&a).is_ok());
    // committed ("done") → Ok, cleans up temp dirs
    let b = tmp();
    std::fs::write(b.join(".restore-journal"), b"done").unwrap();
    std::fs::create_dir_all(b.join(".restore-staging")).unwrap();
    assert!(recover(&b).is_ok());
    assert!(!b.join(".restore-journal").exists() && !b.join(".restore-staging").exists(), "done journal cleaned");
    // unrecoverable/corrupt journal → Err (fail-closed: caller must not open DBs)
    let c = tmp();
    std::fs::write(c.join(".restore-journal"), b"GARBAGE-STATE").unwrap();
    assert_eq!(restore_recovery::recover(&c).unwrap_err().code(), "MEDIA_IO_ERROR");
    assert!(c.join(".restore-journal").exists(), "unrecoverable journal is NOT silently cleared");
}

#[test]
fn simulated_swap_failure_rolls_back_to_exact_prior_state() {
    let b = tmp();
    let src = b.join("src"); std::fs::create_dir_all(&src).unwrap();
    build_live(&src, b"ORIGINAL-MASTER", b"ORIGINAL-THUMB");
    let backup = b.join("backup"); make_backup(&src, &backup, &b);

    let live = b.join("live"); std::fs::create_dir_all(&live).unwrap();
    build_live(&live, b"CURRENT-MASTER", b"CURRENT-THUMB");
    let prior = dir_hashes(&live);

    let err = restore(&RestoreInput { backup_dir: &backup, app_data_dir: &live }, true).unwrap_err();
    assert!(matches!(err, MediaError::Io(_)), "injected failure surfaced");
    // rolled back to the EXACT prior state — never a mixed old/new stand
    assert_eq!(dir_hashes(&live), prior, "live rolled back to the exact prior state");
    assert!(!live.join(".restore-staging").exists() && !live.join(".restore-rollback").exists());
}
