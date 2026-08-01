//! MOBILE-04B2A14-I1 — safe temporary staging GC: real orphan detection + grace/liveness retention,
//! apply deletes ONLY proven orphans, idempotent + crash-repeatable, fail-closed on skew/operation.

use super::*;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

static COUNTER: AtomicU32 = AtomicU32::new(0);
const NOW: u64 = 2_000_000_000; // fixed test clock (year 2033), far above real file mtimes
const GRACE: u64 = 3600;

fn tmp() -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("a14-gc-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
    std::fs::create_dir_all(&d).unwrap();
    d
}
fn write(p: &std::path::Path, bytes: &[u8]) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, bytes).unwrap();
}
fn set_mtime(p: &std::path::Path, secs: u64) {
    let f = std::fs::OpenOptions::new().write(true).open(p).unwrap();
    f.set_modified(UNIX_EPOCH + Duration::from_secs(secs)).unwrap();
}
fn journal(app: &std::path::Path) -> std::path::PathBuf {
    app.join("media").join(INGEST_JOURNAL_DIR)
}
/// Seed a realistic staging tree; returns the app_data_dir.
fn seed(app: &std::path::Path) {
    // published backup (NOT a backup-ws-*) — must never be enumerated/deleted
    write(&app.join("backups").join("snap-KEEP").join("manifest.json"), b"{\"status\":\"complete\"}");
    // orphan crashed snapshot workspace
    write(&app.join("backups").join("backup-ws-OLD").join("part.tmp"), b"PARTIAL");
    // live media master — must never be enumerated/deleted
    write(&app.join("media").join("t").join("aa").join("aaaaaa.jpg"), b"MASTER");
    // orphan ingest temp with NO journal entry → deletable when old
    write(&journal(app).join("t__req1.main.jpg.tmp"), b"ORPHAN-TMP");
    // ingest temp WITH a surviving journal entry → referenced, retained
    write(&journal(app).join("t__req2.main.jpg.tmp"), b"REF-TMP");
    write(&journal(app).join("t__req2.json"), b"{\"state\":\"prepared\"}");
    // young orphan temp (no journal) → within grace, retained
    write(&journal(app).join("t__req3.main.jpg.tmp"), b"YOUNG-TMP");
    set_mtime(&journal(app).join("t__req3.main.jpg.tmp"), NOW - 10);
    // abandoned restore staging — recover() owns it; GC must never enumerate it
    write(&app.join(".restore-staging").join("x"), b"R");
}
fn keys(entries: &[GcEntry]) -> std::collections::BTreeSet<String> {
    entries.iter().map(|e| e.rel_key.clone()).collect()
}

#[test]
fn dry_run_detects_only_old_unreferenced_orphans() {
    let app = tmp();
    seed(&app);
    let plan = analyze(&app, GRACE, NOW).unwrap();
    let d = keys(&plan.deletable);
    assert_eq!(d.len(), 2, "exactly the two old orphans");
    assert!(d.contains("backups/backup-ws-OLD"), "orphan workspace deletable");
    assert!(d.contains("media/.ingest-journal/t__req1.main.jpg.tmp"), "orphan tmp deletable");
    // referenced + young are retained; published backup, live media, restore-staging are never enumerated
    assert!(!d.iter().any(|k| k.contains("req2") || k.contains("req3") || k.contains("snap-KEEP") || k.contains("/aa/") || k.contains(".restore-staging")),
        "referenced/young/live/published never deletable");
    let reasons: std::collections::BTreeSet<_> = plan.retained.iter().map(|r| r.reason.as_str()).collect();
    assert!(reasons.contains("referenced_by_ssot") && reasons.contains("within_grace_period"), "retain reasons present");
}

#[test]
fn apply_deletes_only_orphans_everything_else_survives() {
    let app = tmp();
    seed(&app);
    let r = apply(&app, GRACE, NOW).unwrap();
    assert_eq!(r.deleted, 2, "only the two orphans deleted");
    assert!(!app.join("backups").join("backup-ws-OLD").exists());
    assert!(!journal(&app).join("t__req1.main.jpg.tmp").exists());
    // survivors
    assert!(app.join("backups").join("snap-KEEP").join("manifest.json").exists(), "published backup survives");
    assert!(app.join("media").join("t").join("aa").join("aaaaaa.jpg").exists(), "live media survives");
    assert!(journal(&app).join("t__req2.main.jpg.tmp").exists(), "referenced tmp survives");
    assert!(journal(&app).join("t__req3.main.jpg.tmp").exists(), "young tmp survives");
    assert!(app.join(".restore-staging").join("x").exists(), ".restore-staging survives");
    // idempotent: a second run deletes nothing
    let r2 = apply(&app, GRACE, NOW).unwrap();
    assert_eq!(r2.deleted, 0, "second run is a no-op");
}

#[test]
fn crash_mid_run_is_safely_repeatable() {
    let app = tmp();
    seed(&app);
    // simulate a crash AFTER one orphan was already removed
    std::fs::remove_dir_all(app.join("backups").join("backup-ws-OLD")).unwrap();
    let r = apply(&app, GRACE, NOW).unwrap();
    assert_eq!(r.deleted, 1, "only the remaining orphan is deleted on the repeat run");
    assert!(!journal(&app).join("t__req1.main.jpg.tmp").exists());
    // survivors untouched
    assert!(journal(&app).join("t__req2.main.jpg.tmp").exists());
    assert!(app.join("media").join("t").join("aa").join("aaaaaa.jpg").exists());
}

#[test]
fn operation_in_progress_retains_everything() {
    let app = tmp();
    seed(&app);
    std::fs::write(app.join(".backup-intent"), b"{\"id\":\"x\",\"createdAt\":\"t\",\"appVersion\":\"v\"}").unwrap();
    let plan = analyze(&app, GRACE, NOW).unwrap();
    assert_eq!(plan.deletable_count, 0, "nothing deletable while an operation is pending");
    assert!(plan.retained.iter().all(|r| r.reason == "operation_in_progress"));
    // and apply deletes nothing
    let r = apply(&app, GRACE, NOW).unwrap();
    assert_eq!(r.deleted, 0);
    assert!(app.join("backups").join("backup-ws-OLD").exists(), "orphan kept while op pending");
}

#[test]
fn future_mtime_and_grace_retain_fail_closed() {
    let app = tmp();
    seed(&app);
    // a future mtime (clock skew / invalid) on the orphan tmp → treated as young → retained
    set_mtime(&journal(&app).join("t__req1.main.jpg.tmp"), NOW + 5000);
    let plan = analyze(&app, GRACE, NOW).unwrap();
    let d = keys(&plan.deletable);
    assert!(!d.contains("media/.ingest-journal/t__req1.main.jpg.tmp"), "future-dated file retained (skew fail-closed)");
    // a very large grace retains even the old workspace
    let strict = analyze(&app, u64::MAX, NOW).unwrap();
    assert_eq!(strict.deletable_count, 0, "an effectively infinite grace deletes nothing");
}

// ── mobile-staging content-addressed blob GC (server-DB liveness) ──
use rusqlite::params;
fn server_path(app: &std::path::Path) -> std::path::PathBuf { app.join("lataif_sync_server.db") }
fn open_server(app: &std::path::Path) -> rusqlite::Connection {
    let c = rusqlite::Connection::open(server_path(app)).unwrap();
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS mobile_upload_inbox(tenant_id,branch_id,authenticated_user_id,upload_event_id,state);
         CREATE TABLE IF NOT EXISTS mobile_upload_image(tenant_id,branch_id,authenticated_user_id,upload_event_id,storage_key);",
    ).unwrap();
    c
}
fn add_ref(c: &rusqlite::Connection, scope: &str, ev: &str, storage_key: &str, state: &str) {
    c.execute("INSERT INTO mobile_upload_inbox VALUES(?1,'b','u',?2,?3)", params![scope, ev, state]).unwrap();
    c.execute("INSERT INTO mobile_upload_image VALUES(?1,'b','u',?2,?3)", params![scope, ev, storage_key]).unwrap();
}
/// seed a staging blob, return its storage_key (= staging-relative rel `{scope}/{hh}/{hash}.jpg`).
fn stage(app: &std::path::Path, scope: &str, hash: &str) -> String {
    let rel = format!("{scope}/{}/{}.jpg", &hash[0..2], hash);
    write(&app.join(super::MOBILE_STAGING_DIR).join(scope).join(&hash[0..2]).join(format!("{hash}.jpg")), b"BLOB");
    rel
}
fn blob_key(rel: &str) -> String { format!("{}/{}", super::MOBILE_STAGING_DIR, rel) }

#[test]
fn blob_gc_deletes_only_terminal_unreferenced_blobs() {
    let app = tmp();
    let c = open_server(&app);
    // dead: only conflict + quarantined refs (shared hash, multiple terminal) → deletable
    let dead = stage(&app, "t", "aaaaaaaaaa");
    add_ref(&c, "t", "e1", &dead, "conflict");
    add_ref(&c, "t", "e2", &dead, "quarantined");
    // live: a ready ref → retained
    let live = stage(&app, "t", "bbbbbbbbbb");
    add_ref(&c, "t", "e3", &live, "ready");
    // shared-live: one conflict + one processing (a live state wins) → retained
    let shared = stage(&app, "t", "cccccccccc");
    add_ref(&c, "t", "e4", &shared, "conflict");
    add_ref(&c, "t", "e5", &shared, "processing");
    // young dead: no refs at all → dead, but within grace → retained
    let young = stage(&app, "t", "dddddddddd");
    set_mtime(&app.join(super::MOBILE_STAGING_DIR).join("t").join("dd").join("dddddddddd.jpg"), NOW - 10);
    drop(c);

    let plan = analyze_with_blobs(&app, &server_path(&app), GRACE, NOW).unwrap();
    let d = keys(&plan.deletable);
    assert!(d.contains(&blob_key(&dead)), "terminal-only blob deletable");
    assert!(!d.contains(&blob_key(&live)) && !d.contains(&blob_key(&shared)) && !d.contains(&blob_key(&young)),
        "live/shared-live/young blobs retained");
    let reasons: std::collections::BTreeSet<_> = plan.retained.iter().map(|r| r.reason.as_str()).collect();
    assert!(reasons.contains("referenced_by_inbox") && reasons.contains("within_grace_period"), "blob retain reasons");

    let r = apply_with_blobs(&app, &server_path(&app), GRACE, NOW).unwrap();
    assert_eq!(r.deleted, 1, "only the dead blob deleted");
    assert!(!app.join(super::MOBILE_STAGING_DIR).join("t").join("aa").join("aaaaaaaaaa.jpg").exists());
    assert!(app.join(super::MOBILE_STAGING_DIR).join("t").join("bb").join("bbbbbbbbbb.jpg").exists(), "live blob survives");
    assert!(app.join(super::MOBILE_STAGING_DIR).join("t").join("cc").join("cccccccccc.jpg").exists(), "shared-live blob survives");
    assert_eq!(apply_with_blobs(&app, &server_path(&app), GRACE, NOW).unwrap().deleted, 0, "second run deletes 0");
}

#[test]
fn blob_gc_unknown_state_and_unnormalized_key_are_retained() {
    let app = tmp();
    let c = open_server(&app);
    // an UNKNOWN/future state (not one of the five) must never be inferred as dead
    let unk = stage(&app, "t", "1111111111");
    add_ref(&c, "t", "e1", &unk, "archived");
    // a terminal ref alongside an unknown state → still retained (unknown wins over terminal)
    let mixed = stage(&app, "t", "2222222222");
    add_ref(&c, "t", "e2", &mixed, "quarantined");
    add_ref(&c, "t", "e3", &mixed, "some_new_state");
    drop(c);
    // a non-normalised staging file (wrong shape) → retained regardless of the DB
    write(&app.join(super::MOBILE_STAGING_DIR).join("t").join("x").join("bad.jpg"), b"B"); // hh len 1
    write(&app.join(super::MOBILE_STAGING_DIR).join("loose.jpg"), b"L"); // 1 segment

    let plan = analyze_with_blobs(&app, &server_path(&app), GRACE, NOW).unwrap();
    let d = keys(&plan.deletable);
    assert!(!d.contains(&blob_key(&unk)) && !d.contains(&blob_key(&mixed)), "unknown-state blobs retained");
    assert!(!d.iter().any(|k| k.contains("/x/bad.jpg") || k.ends_with("/loose.jpg")), "non-normalised keys retained");
    let reasons: std::collections::BTreeSet<_> = plan.retained.iter().map(|r| r.reason.as_str()).collect();
    assert!(reasons.contains("unknown_state") && reasons.contains("unnormalized_key"), "explicit retain reasons present");
    assert_eq!(apply_with_blobs(&app, &server_path(&app), GRACE, NOW).unwrap().deleted, 0, "nothing deletable → no delete");
}

#[test]
fn blob_gc_is_independent_across_scopes() {
    let app = tmp();
    let c = open_server(&app);
    // same hash in two scopes: A terminal-only (dead), B ready (live)
    let a = stage(&app, "A", "9999999999"); add_ref(&c, "A", "eA", &a, "conflict");
    let b = stage(&app, "B", "9999999999"); add_ref(&c, "B", "eB", &b, "ready");
    drop(c);
    let plan = analyze_with_blobs(&app, &server_path(&app), GRACE, NOW).unwrap();
    let d = keys(&plan.deletable);
    assert!(d.contains(&blob_key(&a)), "scope A terminal blob deletable");
    assert!(!d.contains(&blob_key(&b)), "scope B live blob (same hash) retained — cross-scope independent");
}

#[test]
fn blob_gc_fail_closed_on_missing_or_corrupt_server_db() {
    let app = tmp();
    let dead = stage(&app, "t", "eeeeeeeeee"); // would be dead if the DB said so
    // missing DB → every blob retained (server_db_unavailable), nothing deletable, apply deletes 0
    let plan = analyze_with_blobs(&app, &server_path(&app), GRACE, NOW).unwrap();
    assert!(!keys(&plan.deletable).contains(&blob_key(&dead)), "missing server DB → blob retained");
    assert!(plan.retained.iter().any(|r| r.reason == "server_db_unavailable"));
    assert_eq!(apply_with_blobs(&app, &server_path(&app), GRACE, NOW).unwrap().deleted, 0, "no delete without a readable DB");
    assert!(app.join(super::MOBILE_STAGING_DIR).join("t").join("ee").join("eeeeeeeeee.jpg").exists());
    // corrupt DB bytes → still fail-closed
    std::fs::write(server_path(&app), b"NOT A SQLITE DB").unwrap();
    let plan2 = analyze_with_blobs(&app, &server_path(&app), GRACE, NOW).unwrap();
    assert!(!keys(&plan2.deletable).contains(&blob_key(&dead)), "corrupt server DB → blob retained");
}

#[test]
fn blob_gc_operation_guard_and_never_scans_media_root() {
    let app = tmp();
    let c = open_server(&app); let dead = stage(&app, "t", "ffffffffff"); add_ref(&c, "t", "e6", &dead, "conflict"); drop(c);
    // a live media master + a media temp must never appear as a mobile-staging blob candidate
    write(&app.join("media").join("t").join("ff").join("ffffffffff.jpg"), b"MASTER");
    // operation pending → ALL retained (blobs too)
    std::fs::write(app.join(".backup-intent"), b"{\"id\":\"x\",\"createdAt\":\"t\",\"appVersion\":\"v\"}").unwrap();
    let plan = analyze_with_blobs(&app, &server_path(&app), GRACE, NOW).unwrap();
    assert_eq!(plan.deletable_count, 0, "operation-in-progress retains blobs too");
    std::fs::remove_file(app.join(".backup-intent")).unwrap();
    let plan2 = analyze_with_blobs(&app, &server_path(&app), GRACE, NOW).unwrap();
    assert!(!plan2.deletable.iter().any(|e| e.rel_key.starts_with("media/t/")) && !plan2.retained.iter().any(|r| r.rel_key.starts_with("media/t/")),
        "media root is NEVER scanned by blob GC");
    assert!(keys(&plan2.deletable).contains(&blob_key(&dead)), "the terminal staging blob is deletable once the operation clears");
}

#[test]
fn execute_boot_gc_uses_real_clock_and_conservative_grace() {
    let app = tmp();
    let real_now = super::now_secs();
    // an orphan tmp older than the default grace (1h) → deletable by the production boot path
    let old = journal(&app).join("t__reqBOOT.main.jpg.tmp");
    write(&old, b"OLD");
    set_mtime(&old, real_now - super::DEFAULT_GRACE_SECS - 600);
    // a fresh orphan tmp → within grace → retained
    let young = journal(&app).join("t__reqFRESH.main.jpg.tmp");
    write(&young, b"NEW");
    let r = super::execute_boot_gc(&app).unwrap();
    assert!(r.deleted >= 1, "boot GC deleted the old orphan under the real clock");
    assert!(!old.exists(), "old orphan removed");
    assert!(young.exists(), "fresh orphan retained by the conservative grace");
}

#[cfg(windows)]
#[test]
fn symlinked_temp_is_retained_if_perm() {
    let app = tmp();
    seed(&app);
    let target = app.join("media").join("t").join("aa").join("aaaaaa.jpg");
    let link = journal(&app).join("t__reqL.main.jpg.tmp");
    if std::os::windows::fs::symlink_file(&target, &link).is_err() {
        return; // no symlink privilege → covered by the containment/symlink guards in code
    }
    let plan = analyze(&app, GRACE, NOW).unwrap();
    assert!(plan.retained.iter().any(|r| r.rel_key.contains("reqL") && r.reason == "symlink"), "symlinked temp retained");
    let r = apply(&app, GRACE, NOW).unwrap();
    assert!(link.exists(), "symlink never followed/deleted");
    let _ = r;
}
