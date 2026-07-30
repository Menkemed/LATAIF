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
fn list_snapshots_lists_only_safe_complete_prechecked() {
    let b = tmp();
    let app = b.join("app"); std::fs::create_dir_all(app.join("backups")).unwrap();
    // one GOOD snapshot under <app>/backups/snap1
    let src = b.join("src"); std::fs::create_dir_all(&src).unwrap();
    build_live(&src, b"MASTER-A", b"THUMB-A");
    make_backup(&src, &app.join("backups").join("snap1"), &b);
    // a FOREIGN dir (no/incompatible manifest) → must be skipped
    let foreign = app.join("backups").join("foreign"); std::fs::create_dir_all(&foreign).unwrap();
    std::fs::write(foreign.join("manifest.json"), b"{\"not\":\"a backup\"}").unwrap();
    // an INCOMPLETE snapshot (status flipped) → must be skipped
    let inc = app.join("backups").join("incomplete");
    make_backup(&src, &inc, &b);
    let raw = std::fs::read_to_string(inc.join("manifest.json")).unwrap().replace("\"complete\"", "\"in_progress\"");
    std::fs::write(inc.join("manifest.json"), raw).unwrap();

    let list = list_snapshots(&app).expect("list ok");
    assert_eq!(list.len(), 1, "only the safe complete snapshot is listed");
    let s = &list[0];
    assert_eq!(s.snapshot_id, "snap1", "opaque id = dir segment, never a path");
    assert_eq!(s.created_at, "2026-07-30T00:00:00Z");
    assert_eq!(s.app_version, "e2e");
    assert_eq!(s.media_file_count, 2);
    assert!(s.db_size_bytes > 0 && s.media_size_bytes > 0, "sanitised sizes present");
    // empty when there is no backups dir at all
    assert!(list_snapshots(&b.join("nope")).unwrap().is_empty());
}

#[test]
fn resolve_snapshot_id_rejects_traversal_absolute_nested_and_unknown() {
    let b = tmp();
    let app = b.join("app"); std::fs::create_dir_all(app.join("backups")).unwrap();
    let src = b.join("src"); std::fs::create_dir_all(&src).unwrap();
    build_live(&src, b"M", b"T");
    make_backup(&src, &app.join("backups").join("good"), &b);

    // unsafe ids are rejected without touching the filesystem
    for bad in ["", ".", "..", "a/b", "a\\b", "../evil", "C:\\x"] {
        assert_eq!(resolve_snapshot_id(&app, bad).unwrap_err().code(), "MEDIA_PATH_OUTSIDE_ROOT", "rejected: {:?}", bad);
    }
    // a safe-looking but UNKNOWN id fails (does not exist under the root)
    assert!(resolve_snapshot_id(&app, "missing").is_err());
    // the real id resolves under the canonical backups root
    let p = resolve_snapshot_id(&app, "good").expect("good resolves");
    assert!(p.ends_with("good"));
    // restore_by_id refuses a traversal id BEFORE any mutation
    assert_eq!(restore_by_id(&app, "../evil").unwrap_err().code(), "MEDIA_PATH_OUTSIDE_ROOT");
}

#[test]
fn restore_by_id_round_trips_from_the_canonical_root() {
    let b = tmp();
    let app = b.join("app"); std::fs::create_dir_all(app.join("backups")).unwrap();
    // snapshot of an ORIGINAL state, published under backups/snapX
    let orig = b.join("orig"); std::fs::create_dir_all(&orig).unwrap();
    build_live(&orig, b"ORIG-MASTER", b"ORIG-THUMB");
    let m = make_backup(&orig, &app.join("backups").join("snapX"), &b);
    let want = dir_hashes(&orig);
    // put a DIFFERENT live tree into the app dir, then restore by id
    build_live(&app, b"LIVE-MASTER-XX", b"LIVE-THUMB-XX");
    assert_ne!({ let mut h = dir_hashes(&app); h.retain(|k, _| !k.starts_with("backups/")); h }, want, "app differs before restore");
    let rm = restore_by_id(&app, "snapX").expect("restore by id ok");
    assert_eq!(rm.status, "complete");
    // the app's DB + media match the original snapshot (ignore the backups/ store itself)
    let mut got = dir_hashes(&app); got.retain(|k, _| !k.starts_with("backups/"));
    assert_eq!(got, want, "restored app tree is hash-identical to the snapshot");
    assert_eq!(verify_restored(&app, &m).unwrap(), 2);
}

#[test]
fn schedule_restore_writes_intent_without_mutation() {
    let b = tmp();
    let app = b.join("app"); std::fs::create_dir_all(app.join("backups")).unwrap();
    build_live(&app, b"LIVE-MASTER", b"LIVE-THUMB");
    make_backup(&app, &app.join("backups").join("snapX"), &b);
    let live_before = { let mut h = dir_hashes(&app); h.retain(|k, _| !k.starts_with("backups/")); h };

    schedule_restore(&app, "snapX").expect("schedule ok");
    assert_eq!(std::fs::read_to_string(app.join(".restore-intent")).unwrap().trim(), "snapX", "intent written");
    // NO DB/media mutation from scheduling
    let live_after = { let mut h = dir_hashes(&app); h.retain(|k, _| !k.starts_with("backups/")); h };
    assert_eq!(live_after, live_before, "scheduling performs no mutation");

    // a traversal / unknown id writes NO intent (fails before)
    std::fs::remove_file(app.join(".restore-intent")).unwrap();
    assert!(schedule_restore(&app, "../evil").is_err());
    assert!(schedule_restore(&app, "missing").is_err());
    assert!(!app.join(".restore-intent").exists(), "no intent on a rejected schedule");
}

#[test]
fn execute_pending_applies_once_and_never_repeats() {
    let b = tmp();
    let app = b.join("app"); std::fs::create_dir_all(app.join("backups")).unwrap();
    // snapshot of an ORIGINAL state
    let orig = b.join("orig"); std::fs::create_dir_all(&orig).unwrap();
    build_live(&orig, b"ORIG-MASTER", b"ORIG-THUMB");
    make_backup(&orig, &app.join("backups").join("snapX"), &b);
    let want = dir_hashes(&orig);
    // a DIFFERENT live tree; schedule + apply at boot
    build_live(&app, b"LIVE-MASTER-X", b"LIVE-THUMB-X");
    schedule_restore(&app, "snapX").unwrap();

    let applied = execute_pending_restore(&app).expect("boot restore ok");
    assert_eq!(applied.as_deref(), Some("snapX"), "the scheduled snapshot was applied");
    let mut got = dir_hashes(&app); got.retain(|k, _| !k.starts_with("backups/"));
    assert_eq!(got, want, "app tree == snapshot after boot restore");
    assert!(!app.join(".restore-intent").exists(), "intent consumed on durable success");
    // exactly-once: a second boot does NOTHING (no repeat)
    assert_eq!(execute_pending_restore(&app).unwrap(), None, "no pending restore on the next boot");
    let mut again = dir_hashes(&app); again.retain(|k, _| !k.starts_with("backups/"));
    assert_eq!(again, want, "state unchanged — no repeat restore");
}

#[test]
fn crash_during_scheduled_boot_restore_recovers_then_completes() {
    let b = tmp();
    let app = b.join("app"); std::fs::create_dir_all(app.join("backups")).unwrap();
    let orig = b.join("orig"); std::fs::create_dir_all(&orig).unwrap();
    build_live(&orig, b"ORIG-MASTER", b"ORIG-THUMB");
    make_backup(&orig, &app.join("backups").join("snapX"), &b);
    let want = dir_hashes(&orig);
    build_live(&app, b"LIVE-MASTER-Y", b"LIVE-THUMB-Y");
    let prior = { let mut h = dir_hashes(&app); h.retain(|k, _| !k.starts_with("backups/")); h };
    schedule_restore(&app, "snapX").unwrap();
    let backup_dir = app.join("backups").join("snapX");

    // the boot restore hard-crashes mid-swap → journal + partial renames + intent still present
    restore_crashing(&RestoreInput { backup_dir: &backup_dir, app_data_dir: &app }, CrashAt::SwapJournalled).unwrap_err();
    assert!(app.join(".restore-journal").exists() && app.join(".restore-intent").exists(), "crash left journal + intent");

    // next boot: recover() rolls the pre-commit crash back to the OLD state (intent kept → re-run)
    recover(&app).unwrap();
    let after_recover = { let mut h = dir_hashes(&app); h.retain(|k, _| !k.starts_with("backups/")); h };
    assert_eq!(after_recover, prior, "rolled back to the exact prior state; intent survives");
    assert!(app.join(".restore-intent").exists(), "intent still pending after rollback");
    // then execute the pending restore to completion
    assert_eq!(execute_pending_restore(&app).unwrap().as_deref(), Some("snapX"));
    let mut got = dir_hashes(&app); got.retain(|k, _| !k.starts_with("backups/"));
    assert_eq!(got, want, "scheduled restore completed after recovery");
    assert!(!app.join(".restore-intent").exists(), "intent consumed exactly once");
}

#[test]
fn commit_crash_before_intent_clear_is_consumed_by_recover_no_repeat() {
    use crate::media::restore_recovery;
    let b = tmp();
    let app = b.join("app"); std::fs::create_dir_all(app.join("backups")).unwrap();
    let orig = b.join("orig"); std::fs::create_dir_all(&orig).unwrap();
    build_live(&orig, b"ORIG-MASTER", b"ORIG-THUMB");
    make_backup(&orig, &app.join("backups").join("snapX"), &b);
    let want = dir_hashes(&orig);
    build_live(&app, b"LIVE-MASTER-Z", b"LIVE-THUMB-Z");
    schedule_restore(&app, "snapX").unwrap();

    // apply the restore fully, then simulate a crash AFTER the durable `done` commit but BEFORE the intent
    // was cleared: a leftover `done` journal + a still-present intent.
    restore_by_id(&app, "snapX").unwrap();
    std::fs::write(app.join(".restore-journal"), b"done").unwrap();
    assert!(app.join(".restore-intent").exists(), "intent still present at the crash point");

    // boot recovery consumes the committed intent → NO repeat restore
    recover(&app).unwrap();
    assert!(!app.join(".restore-intent").exists(), "recover() cleared the committed intent");
    assert_eq!(execute_pending_restore(&app).unwrap(), None, "no repeat restore after a committed crash");
    let mut got = dir_hashes(&app); got.retain(|k, _| !k.starts_with("backups/"));
    assert_eq!(got, want, "state is the snapshot, applied exactly once");
    // sanity: the intent helpers round-trip
    restore_recovery::write_intent(&app, "snapX").unwrap();
    assert_eq!(restore_recovery::read_intent(&app).as_deref(), Some("snapX"));
    restore_recovery::clear_intent(&app).unwrap();
    assert_eq!(restore_recovery::read_intent(&app), None);
}

#[test]
fn restore_moves_stale_server_wal_shm_sidecars_aside() {
    let b = tmp();
    let src = b.join("src"); std::fs::create_dir_all(&src).unwrap();
    build_live(&src, b"SRC-MASTER", b"SRC-THUMB");
    let backup = b.join("backup"); make_backup(&src, &backup, &b);

    let live = b.join("live"); std::fs::create_dir_all(&live).unwrap();
    build_live(&live, b"CUR-MASTER", b"CUR-THUMB");
    // a stale WAL/SHM sitting next to the live server DB would be replayed over a swapped-in DB.
    std::fs::write(live.join("lataif_sync_server.db-wal"), b"STALE-WAL").unwrap();
    std::fs::write(live.join("lataif_sync_server.db-shm"), b"STALE-SHM").unwrap();

    restore(&RestoreInput { backup_dir: &backup, app_data_dir: &live }, false).expect("restore ok");
    // restored DB present, and the stale sidecars are GONE (moved aside as a unit, backup carries none).
    assert!(live.join("lataif_sync_server.db").exists(), "restored server DB present");
    assert!(!live.join("lataif_sync_server.db-wal").exists(), "stale -wal removed (not shadowing restored DB)");
    assert!(!live.join("lataif_sync_server.db-shm").exists(), "stale -shm removed");
    assert!(!live.join(".restore-rollback").exists() && !live.join(".restore-journal").exists());
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
