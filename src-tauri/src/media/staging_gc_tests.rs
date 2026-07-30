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
