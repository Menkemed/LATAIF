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

// ── MOBILE-04B2A12-U2-R1 — boot-scheduled backup: intent + execute_pending_backup exactly-once ──

/// Build a real app_data_dir: media/ + a real sqlite lataif.db (1 link → master + thumbnail) + server DB.
fn build_app(base: &std::path::Path, master: &[u8], thumb: &[u8]) {
    let media = base.join("media");
    std::fs::create_dir_all(&media).unwrap();
    let (mh, ms) = put_media(&media, "t", master);
    let (th, ts) = put_media(&media, "t", thumb);
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
        ma = &mh[0..2], mh = mh, ms = ms, ta = &th[0..2], th = th, ts = ts
    )).unwrap();
    drop(c);
    let server = base.join("lataif_sync_server.db");
    let sc = rusqlite::Connection::open(&server).unwrap();
    sc.execute_batch("CREATE TABLE s(x); INSERT INTO s VALUES(1);").unwrap();
    drop(sc);
}
fn intent(id: &str) -> BackupIntent {
    BackupIntent { id: id.into(), created_at: "2026-07-30T00:00:00Z".into(), app_version: "0.8.23".into() }
}

#[test]
fn scheduled_backup_runs_at_boot_and_never_repeats() {
    let app = tmp();
    build_app(&app, b"MASTER-A", b"THUMB-A");
    write_backup_intent(&app, &intent("snap-boot-1")).unwrap();
    assert_eq!(read_backup_intent(&app).unwrap().id, "snap-boot-1");

    let applied = execute_pending_backup(&app).expect("boot backup ok");
    assert_eq!(applied.as_deref(), Some("snap-boot-1"));
    let out = app.join("backups").join("snap-boot-1");
    assert_eq!(validate(&out), "complete");
    assert!(!app.join(BACKUP_INTENT).exists(), "intent consumed on durable success");
    // exactly-once: a second boot does nothing
    assert_eq!(execute_pending_backup(&app).unwrap(), None, "no pending backup on the next boot");
}

// ── BACKUP-LOCATION — the boot snapshot + the restore listing both use the CONFIGURED root ──
#[test]
fn boot_backup_and_list_use_the_configured_backup_root() {
    let app = tmp();
    build_app(&app, b"MASTER-CFG", b"THUMB-CFG");
    // Configure a backup root OUTSIDE the default `<app>/backups` (v0016 row in the config DB).
    let chosen = app.join("external").join("bk");
    {
        let conn = rusqlite::Connection::open(app.join("lataif_sync_server.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS backup_location_config (tenant_id TEXT PRIMARY KEY, \
             backup_root_path TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT);",
        ).unwrap();
        crate::media::backup_location::set_configured(&conn, &chosen.to_string_lossy(), "owner", "t0").unwrap();
    }
    // Sanity: the resolver now points at the chosen root.
    assert_eq!(crate::media::backup_location::resolve_root(&app), chosen);

    write_backup_intent(&app, &intent("snap-cfg-1")).unwrap();
    assert_eq!(execute_pending_backup(&app).unwrap().as_deref(), Some("snap-cfg-1"));

    // The snapshot landed in the CONFIGURED root, NOT the default one.
    assert_eq!(validate(&chosen.join("snap-cfg-1")), "complete", "snapshot published in the chosen root");
    assert!(!app.join("backups").join("snap-cfg-1").exists(), "nothing written to the default root");

    // The restore listing reads the configured root too.
    let list = crate::media::restore::list_snapshots(&app).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].snapshot_id, "snap-cfg-1");

    // Reset to default → listing now reads the (empty) default root, and the snapshot in the old
    // configured root is left untouched (never moved/deleted).
    {
        let conn = rusqlite::Connection::open(app.join("lataif_sync_server.db")).unwrap();
        crate::media::backup_location::clear_configured(&conn).unwrap();
    }
    assert_eq!(crate::media::backup_location::resolve_root(&app), app.join("backups"));
    assert_eq!(crate::media::restore::list_snapshots(&app).unwrap().len(), 0, "default root is empty after reset");
    assert_eq!(validate(&chosen.join("snap-cfg-1")), "complete", "reset leaves existing snapshots untouched");
}

// ── BACKUP-LOCATION — configured target unreachable at boot: fail-closed, intent kept, no loop/duplicate ──
#[test]
fn boot_backup_missing_configured_target_is_safe_and_retries() {
    let app = tmp();
    build_app(&app, b"MASTER-MISS", b"THUMB-MISS");
    // Configure a root that cannot be created (a drive that is unplugged between schedule and boot).
    let bogus = if cfg!(windows) { "Z:\\lataif\\gone\\bk".to_string() } else { "/proc/gone/bk".to_string() };
    let conf = |pth: &str| {
        let conn = rusqlite::Connection::open(app.join("lataif_sync_server.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS backup_location_config (tenant_id TEXT PRIMARY KEY, \
             backup_root_path TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT);",
        ).unwrap();
        crate::media::backup_location::set_configured(&conn, pth, "owner", "t").unwrap();
    };
    conf(&bogus);
    write_backup_intent(&app, &intent("snap-miss-1")).unwrap();

    // Boot backup ERRORS (target unreachable) — the setup() caller treats this as NON-fatal. It must NOT
    // fall back to the default root and must NOT clear the intent.
    assert!(execute_pending_backup(&app).is_err(), "unreachable target → error, no silent default fallback");
    assert_eq!(read_backup_intent(&app).map(|i| i.id), Some("snap-miss-1".into()), "intent KEPT for a later boot");
    assert!(
        !app.join("backups").exists() || std::fs::read_dir(app.join("backups")).unwrap().next().is_none(),
        "nothing written to the default root (no fallback)"
    );
    // A second boot with the target still gone behaves identically — no loop corruption, no duplicate intent.
    assert!(execute_pending_backup(&app).is_err());
    assert_eq!(read_backup_intent(&app).map(|i| i.id), Some("snap-miss-1".into()), "still exactly one pending intent");

    // Once the target is reachable again, the SAME intent completes exactly once — no double backup.
    let good = app.join("reachable-bk");
    conf(&good.to_string_lossy());
    assert_eq!(execute_pending_backup(&app).unwrap().as_deref(), Some("snap-miss-1"));
    assert_eq!(validate(&good.join("snap-miss-1")), "complete");
    assert!(!app.join(BACKUP_INTENT).exists(), "intent consumed on eventual success");
    std::fs::remove_dir_all(&app).ok();
}

// ── BACKUP-RETENTION — prune after publish over real complete snapshots ──────────────────────────────
fn set_retention(app: &std::path::Path, enabled: bool, keep: i64) {
    let conn = rusqlite::Connection::open(app.join("lataif_sync_server.db")).unwrap();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS backup_retention_config (tenant_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, \
         keep_count INTEGER NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT);",
    ).unwrap();
    crate::media::backup_retention::set_configured(&conn, enabled, keep, "owner", "t").unwrap();
}
fn make_snapshot(app: &std::path::Path, n: u32) {
    write_backup_intent(app, &BackupIntent {
        id: format!("snap-{}", n),
        created_at: format!("2026-07-30T00:00:{:02}Z", n),  // ascending so newest = highest n
        app_version: "0.8.31".into(),
    }).unwrap();
    execute_pending_backup(app).unwrap();
}

#[test]
fn retention_prunes_to_keep_last_n_and_never_the_newest() {
    let app = tmp();
    build_app(&app, b"M-RET", b"T-RET");
    set_retention(&app, true, 2);
    for n in 1..=4 { make_snapshot(&app, n); }
    let snaps = crate::media::restore::list_snapshots(&app).unwrap();
    assert_eq!(snaps.len(), 2, "keeps exactly N=2");
    assert_eq!(snaps[0].snapshot_id, "snap-4", "newest retained");
    assert_eq!(snaps[1].snapshot_id, "snap-3");
    assert!(!app.join("backups").join("snap-1").exists());
    assert!(!app.join("backups").join("snap-2").exists());
    std::fs::remove_dir_all(&app).ok();
}

#[test]
fn retention_disabled_keeps_everything() {
    let app = tmp();
    build_app(&app, b"M-OFF", b"T-OFF");
    set_retention(&app, false, 1); // configured but OFF
    for n in 1..=3 { make_snapshot(&app, n); }
    assert_eq!(crate::media::restore::list_snapshots(&app).unwrap().len(), 3, "nothing pruned while disabled");
    std::fs::remove_dir_all(&app).ok();
}

#[test]
fn retention_n1_keeps_only_the_newest() {
    let app = tmp();
    build_app(&app, b"M-1", b"T-1");
    set_retention(&app, true, 1);
    for n in 1..=3 { make_snapshot(&app, n); }
    let snaps = crate::media::restore::list_snapshots(&app).unwrap();
    assert_eq!(snaps.len(), 1);
    assert_eq!(snaps[0].snapshot_id, "snap-3");
    std::fs::remove_dir_all(&app).ok();
}

#[test]
fn retention_never_deletes_incomplete_or_foreign_dirs() {
    let app = tmp();
    build_app(&app, b"M-F", b"T-F");
    set_retention(&app, true, 1);
    make_snapshot(&app, 1);
    // a foreign / incomplete directory sits in the backups root — must survive a prune untouched
    let foreign = app.join("backups").join("not-a-snapshot");
    std::fs::create_dir_all(&foreign).unwrap();
    std::fs::write(foreign.join("random.txt"), b"hello").unwrap();
    let incomplete = app.join("backups").join("snap-broken");
    std::fs::create_dir_all(&incomplete).unwrap(); // no manifest.json → not a valid snapshot
    make_snapshot(&app, 2); // triggers prune (keep=1 → snap-1 removed)
    assert!(!app.join("backups").join("snap-1").exists(), "old complete snapshot pruned");
    assert!(foreign.exists(), "foreign dir NEVER deleted by prune");
    assert!(incomplete.exists(), "incomplete dir NEVER deleted by prune");
    assert_eq!(crate::media::restore::list_snapshots(&app).unwrap().len(), 1, "only complete snapshots listed");
    std::fs::remove_dir_all(&app).ok();
}

#[test]
fn retention_skips_while_a_restore_intent_is_pending() {
    let app = tmp();
    build_app(&app, b"M-R", b"T-R");
    set_retention(&app, true, 1);
    make_snapshot(&app, 1);
    make_snapshot(&app, 2); // now 1 remains (snap-2), snap-1 pruned
    // simulate a pending restore, then a manual prune → it must SKIP (no overlap with restore)
    crate::media::restore_recovery::write_intent(&app, "snap-2").unwrap();
    // add two more complete snapshots WITHOUT triggering the auto-prune's list (write via execute but the
    // pending intent makes prune skip): create snap-3, snap-4
    std::fs::remove_file(app.join(crate::media::restore_recovery::INTENT)).ok(); // allow creation first
    make_snapshot(&app, 3);
    make_snapshot(&app, 4);
    // re-arm the restore intent, then call prune directly
    crate::media::restore_recovery::write_intent(&app, "snap-4").unwrap();
    let before = crate::media::restore::list_snapshots(&app).unwrap().len();
    let r = crate::media::backup_retention::prune(&app);
    assert!(r.enabled && r.skipped_restore_pending, "prune SKIPS while a restore intent is pending");
    assert_eq!(crate::media::restore::list_snapshots(&app).unwrap().len(), before, "nothing deleted during a pending restore");
    std::fs::remove_dir_all(&app).ok();
}

// A snapshot that cannot be removed (an open handle inside it) must be COUNTED as failed, left in place
// (visible), while the other allowed deletions still happen and the newest backup stays valid — never a
// rollback. Windows-only: an open read handle blocks deletion there; POSIX unlink would still succeed.
#[cfg(windows)]
#[test]
fn retention_delete_failure_is_counted_and_never_rolls_back() {
    let app = tmp();
    build_app(&app, b"M-DF", b"T-DF");
    set_retention(&app, false, 1); // build 3 complete snapshots without auto-pruning
    for n in 1..=3 { make_snapshot(&app, n); }
    // hold a handle inside the OLDEST snapshot with FILE_SHARE_READ ONLY (no FILE_SHARE_DELETE): validate's
    // read still succeeds, but remove_dir_all cannot delete the file → the prune of snap-1 fails.
    use std::os::windows::fs::OpenOptionsExt;
    let held = std::fs::OpenOptions::new().read(true).share_mode(1)
        .open(app.join("backups").join("snap-1").join("manifest.json")).unwrap();
    set_retention(&app, true, 1); // config only (no prune here)
    let r = crate::media::backup_retention::prune(&app);
    assert!(r.enabled);
    assert_eq!(r.failed, 1, "the locked snapshot's delete failure is COUNTED, not swallowed");
    assert_eq!(r.deleted, 1, "the other surplus snapshot was still pruned");
    assert!(app.join("backups").join("snap-1").exists(), "un-deletable snapshot left in place (visible)");
    assert!(!app.join("backups").join("snap-2").exists(), "deletable surplus removed");
    assert_eq!(validate(&app.join("backups").join("snap-3")), "complete", "newest backup stays valid (no rollback)");
    drop(held);
    std::fs::remove_dir_all(&app).ok();
}

// A snapshot-named JUNCTION pointing OUT of the backups root must NEVER be followed/deleted — `is_symlink`
// misses junctions, so the explicit reparse-point guard has to catch it. The external sentinel must survive.
#[cfg(windows)]
#[test]
fn retention_never_follows_a_junction_snapshot_to_an_external_sentinel() {
    let app = tmp();
    build_app(&app, b"M-JT", b"T-JT");
    let sentinel = tmp();
    std::fs::write(sentinel.join("keep.txt"), b"SENTINEL").unwrap();
    set_retention(&app, false, 1);
    make_snapshot(&app, 9); // a real, newest complete snapshot (kept)
    let junc = app.join("backups").join("snap-1");
    let st = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&junc).arg(&sentinel).status().unwrap();
    assert!(st.success(), "mklink /J must create the junction");
    set_retention(&app, true, 1);
    let _ = crate::media::backup_retention::prune(&app);
    assert!(sentinel.join("keep.txt").exists(), "external sentinel reached via a junction snapshot MUST survive prune");
    assert!(sentinel.exists(), "sentinel dir itself untouched");
    assert_eq!(validate(&app.join("backups").join("snap-9")), "complete", "the real newest snapshot is intact");
    let _ = std::process::Command::new("cmd").args(["/C", "rmdir"]).arg(&junc).status(); // unlink junction, don't recurse
    std::fs::remove_dir_all(&app).ok(); std::fs::remove_dir_all(&sentinel).ok();
}

// A NESTED junction inside a snapshot that is being pruned must never be descended into (validate rejects
// the tampered snapshot, and remove_dir_all does not follow reparse points anyway). Sentinel must survive.
#[cfg(windows)]
#[test]
fn retention_prune_never_descends_a_nested_junction() {
    let app = tmp();
    build_app(&app, b"M-JN", b"T-JN");
    let sentinel = tmp();
    std::fs::write(sentinel.join("keep.txt"), b"SENTINEL").unwrap();
    set_retention(&app, false, 1);
    make_snapshot(&app, 1); // surplus (prune target)
    make_snapshot(&app, 2); // newest (kept)
    let nested = app.join("backups").join("snap-1").join("evil-link");
    let st = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&nested).arg(&sentinel).status().unwrap();
    assert!(st.success(), "mklink /J nested");
    set_retention(&app, true, 1);
    let _ = crate::media::backup_retention::prune(&app);
    assert!(sentinel.join("keep.txt").exists(), "external sentinel reached via a NESTED junction MUST survive prune");
    let _ = std::process::Command::new("cmd").args(["/C", "rmdir"]).arg(&nested).status();
    std::fs::remove_dir_all(&app).ok(); std::fs::remove_dir_all(&sentinel).ok();
}

#[test]
fn retention_prunes_in_a_custom_backup_root() {
    let app = tmp();
    build_app(&app, b"M-C", b"T-C");
    let custom = app.join("external-bk");
    {
        let conn = rusqlite::Connection::open(app.join("lataif_sync_server.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS backup_location_config (tenant_id TEXT PRIMARY KEY, backup_root_path TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT);",
        ).unwrap();
        crate::media::backup_location::set_configured(&conn, &custom.to_string_lossy(), "o", "t").unwrap();
    }
    set_retention(&app, true, 1);
    for n in 1..=3 { make_snapshot(&app, n); }
    // snapshots + prune both operate on the CUSTOM root, not the default
    assert!(!app.join("backups").exists() || std::fs::read_dir(app.join("backups")).unwrap().next().is_none());
    let snaps = crate::media::restore::list_snapshots(&app).unwrap();
    assert_eq!(snaps.len(), 1);
    assert_eq!(snaps[0].snapshot_id, "snap-3");
    assert!(custom.join("snap-3").exists() && !custom.join("snap-1").exists());
    std::fs::remove_dir_all(&app).ok();
}

#[test]
fn crash_after_complete_before_intent_clear_consumes_without_double_backup() {
    let app = tmp();
    build_app(&app, b"MASTER-B", b"THUMB-B");
    // first boot: snapshot published
    write_backup_intent(&app, &intent("snap-boot-2")).unwrap();
    execute_pending_backup(&app).unwrap();
    let out = app.join("backups").join("snap-boot-2");
    let published = std::fs::read(out.join("manifest.json")).unwrap();
    // simulate a crash AFTER complete but before the intent was cleared: the intent is back, out_dir exists.
    write_backup_intent(&app, &intent("snap-boot-2")).unwrap();
    let applied = execute_pending_backup(&app).expect("consume ok");
    assert_eq!(applied.as_deref(), Some("snap-boot-2"));
    assert!(!app.join(BACKUP_INTENT).exists(), "intent consumed, not re-run");
    assert_eq!(std::fs::read(out.join("manifest.json")).unwrap(), published, "snapshot NOT rewritten (no double backup)");
}

#[test]
fn crash_during_backup_cleans_stale_temp_and_retries() {
    let app = tmp();
    build_app(&app, b"MASTER-C", b"THUMB-C");
    write_backup_intent(&app, &intent("snap-boot-3")).unwrap();
    // simulate a crashed prior attempt: a leftover temp workspace keyed by the stable created_at, out_dir absent
    let backups = app.join("backups");
    std::fs::create_dir_all(&backups).unwrap();
    let ws = backups.join(format!("backup-ws-{}", &sha256_hex("2026-07-30T00:00:00Z".as_bytes())[..16]));
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::write(ws.join("garbage.tmp"), b"PARTIAL").unwrap();

    let applied = execute_pending_backup(&app).expect("retry ok");
    assert_eq!(applied.as_deref(), Some("snap-boot-3"));
    assert!(!ws.exists(), "stale temp workspace removed");
    assert_eq!(validate(&backups.join("snap-boot-3")), "complete", "snapshot published on retry");
    assert!(!app.join(BACKUP_INTENT).exists());
}

#[test]
fn boot_backup_captures_the_exact_flushed_on_disk_state() {
    let app = tmp();
    build_app(&app, b"MASTER-FLUSHED", b"THUMB-FLUSHED");
    let on_disk_db = sha256_hex(&std::fs::read(app.join("lataif.db")).unwrap());
    write_backup_intent(&app, &intent("snap-flush-1")).unwrap();
    execute_pending_backup(&app).unwrap();
    let raw = std::fs::read(app.join("backups").join("snap-flush-1").join("manifest.json")).unwrap();
    let m: BackupManifest = serde_json::from_slice(&raw).unwrap();
    assert_eq!(m.db.sha256, on_disk_db, "boot snapshot contains exactly the on-disk (flushed) frontend DB");
    // and the published copy is byte-identical to the DB that was on disk when the intent was written
    assert_eq!(sha256_hex(&std::fs::read(app.join("backups").join("snap-flush-1").join("lataif.db")).unwrap()), on_disk_db);
}

#[test]
fn no_intent_means_no_backup() {
    let app = tmp();
    build_app(&app, b"M", b"T");
    // a crash AFTER the flush but BEFORE the intent leaves no intent → boot performs no backup.
    assert_eq!(execute_pending_backup(&app).unwrap(), None);
    assert!(!app.join("backups").exists() || std::fs::read_dir(app.join("backups")).unwrap().next().is_none(), "no snapshot produced");
}

#[test]
fn corrupt_existing_target_keeps_intent_and_fails_closed() {
    let app = tmp();
    build_app(&app, b"MASTER-Q", b"THUMB-Q");
    // publish a valid snapshot, then TAMPER one media file so the target is no longer fully valid.
    write_backup_intent(&app, &intent("snap-corrupt-1")).unwrap();
    execute_pending_backup(&app).unwrap();
    let out = app.join("backups").join("snap-corrupt-1");
    let raw = std::fs::read(out.join("manifest.json")).unwrap();
    let m: BackupManifest = serde_json::from_slice(&raw).unwrap();
    std::fs::write(out.join(&m.files[0].rel_path), b"TAMPERED").unwrap();
    // a fresh boot with the SAME intent must NOT treat the corrupt target as done.
    write_backup_intent(&app, &intent("snap-corrupt-1")).unwrap();
    let err = execute_pending_backup(&app).unwrap_err();
    assert_eq!(err.code(), "MEDIA_FILE_HASH_MISMATCH", "corrupt target fails closed");
    assert!(read_backup_intent(&app).is_some(), "intent REMAINS (not blindly consumed)");
    // an incomplete manifest is likewise rejected
    let raw2 = std::fs::read_to_string(out.join("manifest.json")).unwrap().replace("\"complete\"", "\"partial\"");
    std::fs::write(out.join("manifest.json"), raw2).unwrap();
    assert_eq!(execute_pending_backup(&app).unwrap_err().code(), "MEDIA_RESTORE_INCOMPLETE_BACKUP");
    assert!(read_backup_intent(&app).is_some(), "intent still remains for an incomplete target");
}

#[test]
fn backup_intent_round_trips_and_ignores_corrupt() {
    let app = tmp();
    assert!(read_backup_intent(&app).is_none());
    write_backup_intent(&app, &intent("snap-x")).unwrap();
    let got = read_backup_intent(&app).unwrap();
    assert_eq!((got.id.as_str(), got.app_version.as_str()), ("snap-x", "0.8.23"));
    std::fs::write(app.join(BACKUP_INTENT), b"{ not json").unwrap();
    assert!(read_backup_intent(&app).is_none(), "corrupt intent → None (no unintended backup)");
    clear_backup_intent(&app).unwrap();
    assert!(!app.join(BACKUP_INTENT).exists());
}

/// helper: parse a published manifest's status.
fn validate(out: &std::path::Path) -> String {
    let raw = std::fs::read(out.join("manifest.json")).unwrap();
    let m: BackupManifest = serde_json::from_slice(&raw).unwrap();
    m.status
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
