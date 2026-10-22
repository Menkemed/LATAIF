//! RESTORE-SAFETY — a restore never makes data disappear without a trace. Real backup dirs, real restore,
//! real SQLite files and media trees in isolated temp folders.
//!
//!   §1 removed photo + new data since the backup → restored DB byte-identical, the removed photo is NOT
//!      re-linked, its file is filled back (proven), the photo added since the backup is archived (kept),
//!      the archive is the exact prior state, the history records the restore
//!   §2 fill-in identity: tampered / wrong size / wrong name / missing source are refused, never copied
//!   §3 crash right after the commit, after the fill-in, after the archive rename → recover() finishes
//!   §4 restore twice → two archives, the first untouched; same-second ids never collide
//!   §5 not enough / unknown free space → refused BEFORE anything is touched (also when scheduling)
//!   §6 an unarchived set-aside state blocks a new restore and is never deleted; boot recovery archives it
//!   §7 archive step fails → committed restore stays, nothing deleted, recover() completes later
//!   §8 a rollback that cannot move an original back keeps it (never deleted) and finishes later
//!   §9 the history survives a later restore and carries no path
//!   §10 the preview: exact numbers for what it compares, "not determined" for the rest, no writes

use super::*;
use crate::media::backup;
use crate::media::restore::{
    execute_pending_restore, recover, restore_by_id, restore_crashing, schedule_restore, CrashAt, RestoreInput,
};
use crate::media::restore_recovery::{rollback_to_prior, JOURNAL, ROLLBACK, STAGING};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);
fn tmp() -> PathBuf {
    let d = std::env::temp_dir().join(format!("rsafe-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
    std::fs::create_dir_all(&d).unwrap();
    d
}
fn key_of(bytes: &[u8]) -> (String, String) {
    let h = sha256_hex(bytes);
    (format!("t/{}/{}.jpg", &h[0..2], h), h)
}
fn sql(base: &Path, s: &str) {
    let c = rusqlite::Connection::open(base.join(FRONT_DB)).unwrap();
    c.execute_batch(s).unwrap();
}
fn q(base: &Path, s: &str) -> Vec<String> {
    let c = rusqlite::Connection::open_with_flags(base.join(FRONT_DB), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let mut st = c.prepare(s).unwrap();
    let v = st.query_map([], |r| r.get::<_, String>(0)).unwrap().map(|x| x.unwrap()).collect();
    v
}

/// A photo of a product: master generation row (+ file unless `on_disk` is false) and a gallery link.
struct Ph<'a> {
    link: &'a str,
    media: &'a str,
    product: &'a str,
    removed: bool,
    bytes: &'a [u8],
    on_disk: bool,
}

fn add_photo(base: &Path, p: &Ph) {
    let (key, h) = key_of(p.bytes);
    if p.on_disk {
        let abs = base.join("media").join(&key);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(abs, p.bytes).unwrap();
    }
    sql(base, &format!(
        "INSERT INTO media_objects VALUES('t','{m}','b-{m}',NULL);
         INSERT INTO media_blobs VALUES('t','b-{m}','present',1);
         INSERT INTO media_blob_generations VALUES('t','b-{m}',1,'available','{k}','{h}',{s},'jpg');
         INSERT INTO media_links VALUES('t','{l}','{m}','stock_image',{d},'product','{p}');",
        m = p.media, k = key, h = h, s = p.bytes.len(), l = p.link, p = p.product,
        d = if p.removed { "'2026-10-01T00:00:00Z'" } else { "NULL" }
    ));
}

fn build(base: &Path, products: &[&str], photos: &[Ph], server: &[u8]) {
    std::fs::create_dir_all(base.join("media")).unwrap();
    sql(base,
        "CREATE TABLE products(id TEXT PRIMARY KEY);
         CREATE TABLE media_links(tenant_id,link_id,media_id,media_role,deleted_at,entity_type,entity_id);
         CREATE TABLE media_objects(tenant_id,media_id,master_blob_id,deleted_at);
         CREATE TABLE media_blobs(tenant_id,blob_id,blob_status,current_generation_no);
         CREATE TABLE media_blob_generations(tenant_id,blob_id,generation_no,gen_status,storage_key,stored_blob_hash,byte_size,extension);
         CREATE TABLE media_variants(tenant_id,variant_id,media_id,variant_type,blob_id,deleted_at);
         CREATE TABLE media_ingest_jobs(tenant_id,target_media_id,target_blob_id,state);");
    for p in products {
        sql(base, &format!("INSERT INTO products VALUES('{p}');"));
    }
    for p in photos {
        add_photo(base, p);
    }
    server_db(base, server);
}
/// A real SQLite server DB holding one marker row (the backup checkpoints it, so it must be a DB).
fn server_db(base: &Path, marker: &[u8]) {
    let c = rusqlite::Connection::open(base.join("lataif_sync_server.db")).unwrap();
    c.execute_batch("CREATE TABLE IF NOT EXISTS s(x BLOB);").unwrap();
    c.execute("INSERT INTO s VALUES(?1)", [marker]).unwrap();
}

/// Snapshot `live` into `<app>/backups/<id>` with the REAL backup host.
fn backup_into(live: &Path, app: &Path, id: &str, ws: &Path) -> backup::BackupManifest {
    let front = live.join(FRONT_DB);
    let conn = rusqlite::Connection::open(&front).unwrap();
    let selection = backup::collect_selection_from_db(&conn).unwrap();
    drop(conn);
    let server = live.join("lataif_sync_server.db");
    let out = app.join("backups").join(id);
    let input = backup::SnapshotInput {
        media_root: &live.join("media"), frontend_db: &front, server_db: Some(&server), selection: &selection,
        created_at: "2026-10-20T00:00:00Z".into(), app_version: "test".into(), schema_version: "s1".into(),
        media_schema_version: "m1".into(), out_dir: &out, workspace_parent: ws,
    };
    backup::snapshot(&input).unwrap()
}

/// The data set (DBs + media), without the backups store, history, archive and transient dirs.
fn data_set(base: &Path) -> std::collections::BTreeMap<String, String> {
    let mut out = std::collections::BTreeMap::new();
    let mut stack = vec![base.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd {
            let p = e.unwrap().path();
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            if d == base && (name.starts_with(".restore-") || name == "backups" || name == HISTORY_FILE || name == ARCHIVE_DIR) {
                continue;
            }
            if d.ends_with("media") || true {
                if p.is_dir() { stack.push(p); continue; }
            }
            if name == "archive.json" && d == base { continue; }
            let rel = p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
            out.insert(rel, sha256_hex(&std::fs::read(&p).unwrap()));
        }
    }
    out
}
fn archives(app: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(app.join(ARCHIVE_DIR)).map(|r| r.flatten().map(|e| e.path()).collect()).unwrap_or_default();
    v.sort();
    v
}
fn archive_data(dir: &Path) -> std::collections::BTreeMap<String, String> {
    let mut d = data_set(dir);
    d.remove("archive.json");
    d
}
fn events(app: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(app.join(HISTORY_FILE)).unwrap_or_default().lines().map(|l| serde_json::from_str(l).expect("history line is JSON")).collect()
}
fn ev_names(app: &Path) -> Vec<String> {
    events(app).iter().map(|e| e["event"].as_str().unwrap().to_string()).collect()
}
fn no_transients(app: &Path) -> bool {
    [STAGING, ROLLBACK, JOURNAL, CONTEXT_FILE].iter().all(|n| !app.join(n).exists())
}

/// The standard scenario: snapshot S = product P1 with photo A (active) and photo B (removed, file on disk);
/// AFTER the backup: A removed, product P2 with photo C added, server DB changed.
fn scenario() -> (PathBuf, PathBuf, backup::BackupManifest) {
    let b = tmp();
    let app = b.join("app");
    std::fs::create_dir_all(app.join("backups")).unwrap();
    build(&app, &["P1"], &[
        Ph { link: "lA", media: "mA", product: "P1", removed: false, bytes: b"PHOTO-A-active-in-backup", on_disk: true },
        Ph { link: "lB", media: "mB", product: "P1", removed: true, bytes: b"PHOTO-B-removed-before-backup-file-kept", on_disk: true },
    ], b"SERVER-AT-BACKUP");
    let m = backup_into(&app, &app, "snapS", &b);
    sql(&app, "UPDATE media_links SET deleted_at='2026-10-21T00:00:00Z' WHERE link_id='lA'; INSERT INTO products VALUES('P2');");
    add_photo(&app, &Ph { link: "lC", media: "mC", product: "P2", removed: false, bytes: b"PHOTO-C-added-after-backup", on_disk: true });
    server_db(&app, b"SERVER-NOW");
    (b, app, m)
}

#[test]
fn s1_removed_photo_and_new_data_restore_is_exact_and_loses_nothing() {
    let (_b, app, m) = scenario();
    let prior = data_set(&app);
    let (key_b, _) = key_of(b"PHOTO-B-removed-before-backup-file-kept");
    let (key_c, _) = key_of(b"PHOTO-C-added-after-backup");
    assert!(!m.files.iter().any(|f| f.rel_path == key_b), "B is not in the backup (removed before it)");

    restore_by_id(&app, "snapS").expect("restore ok");

    // the restored DBs are the snapshot, byte for byte
    assert_eq!(sha256_hex(&std::fs::read(app.join(FRONT_DB)).unwrap()), m.db.sha256);
    assert_eq!(sha256_hex(&std::fs::read(app.join("lataif_sync_server.db")).unwrap()), m.additional_db_files[0].sha256);
    // the gallery is the snapshot's: A active again (it was active then), B stays removed (NOT re-linked)
    assert_eq!(q(&app, "SELECT link_id FROM media_links WHERE deleted_at IS NULL ORDER BY link_id"), vec!["lA".to_string()]);
    assert_eq!(q(&app, "SELECT link_id FROM media_links WHERE deleted_at IS NOT NULL ORDER BY link_id"), vec!["lB".to_string()]);
    assert_eq!(q(&app, "SELECT id FROM products ORDER BY id"), vec!["P1".to_string()]);
    // B's file is back (the restored DB lists it; proven by name, size, hash); C is not in the live media
    assert!(app.join("media").join(&key_b).exists(), "B filled back");
    assert!(!app.join("media").join(&key_c).exists(), "C belongs to data the restore replaced");
    // ... but C is NOT gone: the whole prior state is archived, exactly
    let arcs = archives(&app);
    assert_eq!(arcs.len(), 1, "one archive");
    assert_eq!(archive_data(&arcs[0]), prior, "archive == exact prior state (DBs + all media incl. C)");
    assert!(arcs[0].join("media").join(&key_c).exists());
    let meta: serde_json::Value = serde_json::from_slice(&std::fs::read(arcs[0].join("archive.json")).unwrap()).unwrap();
    assert_eq!(meta["replacedBySnapshotId"], "snapS");
    assert!(no_transients(&app), "no staging/rollback/journal/context left");
    // history: started → committed, with the archive id and the fill-in count
    let ev = events(&app);
    let names: Vec<&str> = ev.iter().map(|e| e["event"].as_str().unwrap()).collect();
    assert_eq!(&names[names.len() - 2..], &["started", "committed"]);
    let c = ev.last().unwrap();
    assert_eq!(c["snapshotId"], "snapS");
    assert_eq!(c["archiveId"].as_str().unwrap(), arcs[0].file_name().unwrap().to_str().unwrap());
    assert_eq!(c["counts"]["fill"]["filled"], 1);
    assert_eq!(c["counts"]["archive"]["files"], 5, "2 DBs + 3 media files archived");
}

#[test]
fn s2_fill_in_refuses_anything_not_proven() {
    let b = tmp();
    let app = b.join("app");
    std::fs::create_dir_all(app.join("backups")).unwrap();
    build(&app, &["P1"], &[
        Ph { link: "lA", media: "mA", product: "P1", removed: false, bytes: b"A-active", on_disk: true },
        Ph { link: "lG", media: "mG", product: "P1", removed: true, bytes: b"G-good-removed", on_disk: true },
        Ph { link: "lT", media: "mT", product: "P1", removed: true, bytes: b"T-will-be-tampered", on_disk: true },
        Ph { link: "lZ", media: "mZ", product: "P1", removed: true, bytes: b"Z-will-change-size", on_disk: true },
        Ph { link: "lM", media: "mM", product: "P1", removed: true, bytes: b"M-never-on-disk", on_disk: false },
    ], b"S");
    // a row whose file NAME is not its hash: the bytes match the row's hash, the name does not → refused
    let wrong = b"W-content";
    let (_, hw) = key_of(wrong);
    let wkey = format!("t/aa/{}.jpg", "a".repeat(64));
    std::fs::create_dir_all(app.join("media/t/aa")).unwrap();
    std::fs::write(app.join("media").join(&wkey), wrong).unwrap();
    sql(&app, &format!(
        "INSERT INTO media_objects VALUES('t','mW','b-mW',NULL); INSERT INTO media_blobs VALUES('t','b-mW','present',1);
         INSERT INTO media_blob_generations VALUES('t','b-mW',1,'available','{wkey}','{hw}',{},'jpg');
         INSERT INTO media_links VALUES('t','lW','mW','stock_image','2026-10-01T00:00:00Z','product','P1');", wrong.len()));
    backup_into(&app, &app, "snapS", &b);
    // after the backup the old files of T and Z are altered — same name, other bytes
    let (kt, _) = key_of(b"T-will-be-tampered");
    let (kz, _) = key_of(b"Z-will-change-size");
    std::fs::write(app.join("media").join(&kt), b"T-WILL-BE-TAMPERED").unwrap(); // same size, other hash
    std::fs::write(app.join("media").join(&kz), b"Z-short").unwrap(); // other size

    restore_by_id(&app, "snapS").expect("restore ok");
    let (kg, _) = key_of(b"G-good-removed");
    let (km, _) = key_of(b"M-never-on-disk");
    assert!(app.join("media").join(&kg).exists(), "the proven file is filled back");
    for (k, why) in [(&kt, "tampered"), (&kz, "size"), (&km, "missing"), (&wkey, "name≠hash")] {
        assert!(!app.join("media").join(k).exists(), "{why}: never copied into the restored media");
    }
    let c = events(&app).into_iter().last().unwrap();
    assert_eq!(c["counts"]["fill"]["filled"], 1);
    assert_eq!(c["counts"]["fill"]["refused"], 3, "tampered + size + name");
    assert_eq!(c["counts"]["fill"]["sourceMissing"], 1);
    assert_eq!(c["counts"]["fill"]["present"], 1, "A came with the backup — never overwritten");
    // nothing was lost: every old file sits in the archive, byte for byte as it was
    let arc = &archives(&app)[0];
    assert_eq!(std::fs::read(arc.join("media").join(&kt)).unwrap(), b"T-WILL-BE-TAMPERED");
    assert_eq!(std::fs::read(arc.join("media").join(&wkey)).unwrap(), wrong);
}

#[test]
fn s3_crash_after_the_commit_is_finished_by_recover() {
    for crash in [CrashAt::Committed, CrashAt::FilledIn, CrashAt::Archived] {
        let (_b, app, _m) = scenario();
        let prior = data_set(&app);
        // the reference: the same restore without a crash, in a twin scenario
        let (_b2, twin, _m2) = scenario();
        restore_by_id(&twin, "snapS").unwrap();
        let want = data_set(&twin);

        schedule_restore(&app, "snapS").unwrap();
        let backup_dir = app.join("backups").join("snapS");
        restore_crashing(&RestoreInput { backup_dir: &backup_dir, app_data_dir: &app }, crash).unwrap_err();
        assert_eq!(std::fs::read_to_string(app.join(JOURNAL)).unwrap(), "done", "{crash:?}: crashed after the commit");

        recover(&app).unwrap();
        assert_eq!(data_set(&app), want, "{crash:?}: the committed restore, finished (incl. fill-in)");
        let arcs = archives(&app);
        assert_eq!(arcs.len(), 1, "{crash:?}: exactly one archive");
        assert_eq!(archive_data(&arcs[0]), prior, "{crash:?}: archive == exact prior state");
        assert!(no_transients(&app), "{crash:?}: nothing transient left");
        assert!(!app.join(".restore-intent").exists(), "{crash:?}: intent consumed");
        assert_eq!(execute_pending_restore(&app).unwrap(), None, "{crash:?}: never repeats");
        assert!(ev_names(&app).contains(&"recovered_completed".to_string()), "{crash:?}: recorded");
    }
}

#[test]
fn s4_restoring_twice_keeps_both_archives() {
    let (_b, app, _m) = scenario();
    restore_by_id(&app, "snapS").unwrap();
    let first = archives(&app);
    let first_data = archive_data(&first[0]);
    restore_by_id(&app, "snapS").unwrap(); // same second → the id must not collide
    let both = archives(&app);
    assert_eq!(both.len(), 2, "a second archive, the first kept");
    assert_ne!(both[0], both[1]);
    assert_eq!(archive_data(&first[0]), first_data, "the first archive is untouched");
    assert_eq!(ev_names(&app).iter().filter(|e| *e == "committed").count(), 2);
}

#[test]
fn s5_not_enough_or_unknown_space_refuses_before_touching_anything() {
    for (free, code) in [(Some(1024u64), "MEDIA_RESTORE_INSUFFICIENT_SPACE"), (None, "MEDIA_RESTORE_FREE_SPACE_UNKNOWN")] {
        let (_b, app, _m) = scenario();
        let prior = data_set(&app);
        FAKE_FREE_SPACE.with(|c| c.set(Some(free)));
        assert_eq!(schedule_restore(&app, "snapS").unwrap_err().code(), code, "refused when scheduling");
        assert!(!app.join(".restore-intent").exists(), "no intent");
        assert_eq!(restore_by_id(&app, "snapS").unwrap_err().code(), code, "refused at the restore");
        FAKE_FREE_SPACE.with(|c| c.set(None));
        assert_eq!(data_set(&app), prior, "nothing touched");
        assert!(no_transients(&app) && archives(&app).is_empty());
        let last = events(&app).into_iter().last().unwrap();
        assert_eq!(last["event"], "aborted");
        assert_eq!(last["code"], code);
    }
    // room for the staged copy, but not for the fill-in on top → refused after staging, still before the swap
    let b = tmp();
    let app = b.join("app");
    std::fs::create_dir_all(app.join("backups")).unwrap();
    let big = vec![7u8; 300_000];
    build(&app, &["P1"], &[
        Ph { link: "lA", media: "mA", product: "P1", removed: false, bytes: b"small", on_disk: true },
        Ph { link: "lB", media: "mB", product: "P1", removed: true, bytes: &big, on_disk: true },
    ], b"S");
    let m = backup_into(&app, &app, "snapS", &b);
    let prior = data_set(&app);
    FAKE_FREE_SPACE.with(|c| c.set(Some(Some(with_margin(crate::media::restore::staged_bytes(&m))))));
    assert_eq!(restore_by_id(&app, "snapS").unwrap_err().code(), "MEDIA_RESTORE_INSUFFICIENT_SPACE");
    FAKE_FREE_SPACE.with(|c| c.set(None));
    assert_eq!(data_set(&app), prior, "nothing touched");
    assert!(no_transients(&app), "the staged copy is gone again");
}

#[test]
fn s6_an_unarchived_set_aside_state_is_never_deleted() {
    let (_b, app, _m) = scenario();
    std::fs::create_dir_all(app.join(ROLLBACK)).unwrap();
    std::fs::write(app.join(ROLLBACK).join(FRONT_DB), b"OLD-STATE-OF-AN-EARLIER-RESTORE").unwrap();
    assert_eq!(restore_by_id(&app, "snapS").unwrap_err().code(), "MEDIA_RESTORE_ROLLBACK_PRESENT");
    assert_eq!(schedule_restore(&app, "snapS").unwrap_err().code(), "MEDIA_RESTORE_ROLLBACK_PRESENT");
    assert_eq!(std::fs::read(app.join(ROLLBACK).join(FRONT_DB)).unwrap(), b"OLD-STATE-OF-AN-EARLIER-RESTORE", "kept");
    // boot recovery archives it untouched — then a restore works again
    recover(&app).unwrap();
    let arcs = archives(&app);
    assert_eq!(arcs.len(), 1);
    assert_eq!(std::fs::read(arcs[0].join(FRONT_DB)).unwrap(), b"OLD-STATE-OF-AN-EARLIER-RESTORE");
    assert!(ev_names(&app).contains(&"orphan_rollback_archived".to_string()));
    restore_by_id(&app, "snapS").expect("unblocked");
    assert_eq!(archives(&app).len(), 2);
}

#[test]
fn s7_archive_step_failing_keeps_everything_until_recover() {
    let (_b, app, m) = scenario();
    let prior = data_set(&app);
    std::fs::write(app.join(ARCHIVE_DIR), b"a FILE where the archive folder belongs").unwrap();
    restore_by_id(&app, "snapS").expect("the restore itself is committed");
    assert_eq!(sha256_hex(&std::fs::read(app.join(FRONT_DB)).unwrap()), m.db.sha256, "committed state in place");
    assert!(app.join(JOURNAL).exists() && app.join(CONTEXT_FILE).exists(), "journal + context kept");
    assert_eq!(data_set(&app.join(ROLLBACK)), prior, "the prior state waits, complete");
    assert!(ev_names(&app).contains(&"finish_deferred".to_string()));
    assert_eq!(restore_by_id(&app, "snapS").unwrap_err().code(), "MEDIA_RESTORE_ROLLBACK_PRESENT", "no restore over it");
    // the obstacle is gone at the next boot → recover() archives and cleans up
    std::fs::remove_file(app.join(ARCHIVE_DIR)).unwrap();
    recover(&app).unwrap();
    let arcs = archives(&app);
    assert_eq!(arcs.len(), 1);
    assert_eq!(archive_data(&arcs[0]), prior);
    assert!(no_transients(&app));
    assert_eq!(ev_names(&app).last().unwrap(), "recovered_completed");
}

#[cfg(windows)]
#[test]
fn s8_rollback_that_cannot_move_an_original_back_keeps_it() {
    use std::os::windows::fs::OpenOptionsExt;
    let b = tmp();
    let live = b.join("live");
    let rollback = live.join(ROLLBACK);
    std::fs::create_dir_all(rollback.join("media")).unwrap();
    std::fs::write(rollback.join("media").join("orig.jpg"), b"ORIGINAL").unwrap();
    std::fs::write(rollback.join(FRONT_DB), b"ORIGINAL-DB").unwrap();
    // the partially swapped-in copy holds a file nobody may delete right now
    std::fs::create_dir_all(live.join("media")).unwrap();
    std::fs::write(live.join("media").join("restored.jpg"), b"RESTORED").unwrap();
    let lock = std::fs::OpenOptions::new().read(true).share_mode(0).open(live.join("media").join("restored.jpg")).unwrap();
    assert!(rollback_to_prior(&live, &rollback).is_err(), "incomplete → Err");
    assert_eq!(std::fs::read(rollback.join("media").join("orig.jpg")).unwrap(), b"ORIGINAL", "the original is KEPT");
    drop(lock);
    rollback_to_prior(&live, &rollback).expect("finishes later");
    assert_eq!(std::fs::read(live.join("media").join("orig.jpg")).unwrap(), b"ORIGINAL");
    assert_eq!(std::fs::read(live.join(FRONT_DB)).unwrap(), b"ORIGINAL-DB");
    assert!(!rollback.exists());
}

#[test]
fn s9_history_survives_a_later_restore_and_holds_no_path() {
    let (b, app, _m) = scenario();
    restore_by_id(&app, "snapS").unwrap();
    let after_first = std::fs::read_to_string(app.join(HISTORY_FILE)).unwrap();
    // a second, different snapshot taken now, restored
    backup_into(&app, &app, "snapT", &b);
    restore_by_id(&app, "snapT").unwrap();
    let all = std::fs::read_to_string(app.join(HISTORY_FILE)).unwrap();
    assert!(all.starts_with(&after_first), "the earlier lines are still there, unchanged");
    let ids: Vec<String> = events(&app).iter().filter(|e| e["event"] == "committed").map(|e| e["snapshotId"].as_str().unwrap().to_string()).collect();
    assert_eq!(ids, vec!["snapS", "snapT"]);
    let tmpdir = std::env::temp_dir().to_string_lossy().to_string();
    assert!(!all.contains(&tmpdir) && !all.contains(":\\") && !all.contains("rsafe-"), "no path in the history");
}

#[test]
fn s10_preview_is_exact_where_it_compares_and_writes_nothing() {
    let (_b, app, _m) = scenario();
    let before = data_set(&app);
    let p = crate::media::restore_preview::preview(&app, "snapS").expect("preview");
    assert!(p.live_db_read && !p.field_changes_compared);
    let products = p.records.iter().find(|r| r.table == "products").unwrap();
    assert_eq!((products.lost, products.returning), (Some(1), Some(0)), "P2 would be lost");
    let invoices = p.records.iter().find(|r| r.table == "invoices").unwrap();
    assert_eq!((invoices.lost, invoices.returning), (None, None), "a table that is not there: not determined, no number");
    assert_eq!(p.photos_visible_again, Some(1), "A comes back to its gallery");
    assert_eq!(p.photos_leaving, Some(1), "C leaves its gallery");
    assert_eq!(p.media_files_not_in_snapshot, 2, "B and C are not in the backup");
    assert_eq!(p.files_filled_in, Some(1), "B is copied back");
    assert_eq!(p.files_still_missing, Some(0));
    assert_eq!(p.archive_files, 5, "2 DBs + 3 media files");
    assert!(p.space_needed_bytes > 0 && p.space_free_bytes.is_some());
    assert_eq!(data_set(&app), before, "the preview wrote nothing");
    assert!(!app.join(HISTORY_FILE).exists() && archives(&app).is_empty() && no_transients(&app));
}

#[test]
fn archive_ids_never_collide() {
    let b = tmp();
    let now = chrono::Utc::now();
    let a = new_archive_id(&b, now);
    std::fs::create_dir_all(b.join(ARCHIVE_DIR).join(&a)).unwrap();
    let a2 = new_archive_id(&b, now);
    assert_ne!(a, a2);
    assert!(a2.starts_with(&a));
}
