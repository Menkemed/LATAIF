//! MEDIA-ROOT-GC — REAL host proofs. Reference set = every tracked generation (current AND pinned/old), so
//! nothing the DB tracks is ever removed. The move runs only via the boot path; the quarantine is retained
//! and purged ONLY by an explicit finalize. Recovery reconciles (move-back) and never blind-deletes.

use super::*;
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn tmp() -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("mgc-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn put_media(root: &std::path::Path, scope: &str, bytes: &[u8]) -> (String, String, u64) {
    let hash = super::super::storage::sha256_hex(bytes);
    let rel = format!("{}/{}/{}.jpg", scope, &hash[0..2], hash);
    let abs = root.join(&rel);
    std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
    std::fs::write(&abs, bytes).unwrap();
    (rel.replace('\\', "/"), hash, bytes.len() as u64)
}

/// A real lataif.db whose media_blob_generations table lists exactly the given storage_keys as tracked.
fn make_front(base: &std::path::Path, storage_keys: &[&str]) {
    let conn = rusqlite::Connection::open(base.join("lataif.db")).unwrap();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS media_blob_generations(tenant_id,blob_id,generation_no,gen_status,storage_key,stored_blob_hash,byte_size,extension,current_generation_no,deleted_at);
         DELETE FROM media_blob_generations;",
    ).unwrap();
    for (i, k) in storage_keys.iter().enumerate() {
        conn.execute("INSERT INTO media_blob_generations VALUES('t','b',?1,'available',?2,'h',10,'jpg',1,NULL)", rusqlite::params![i as i64 + 1, k]).unwrap();
    }
}

const GC_RUNS_DDL: &str = "CREATE TABLE media_gc_runs(run_id TEXT PRIMARY KEY, state TEXT NOT NULL, quarantined INTEGER NOT NULL DEFAULT 0, purged INTEGER NOT NULL DEFAULT 0, moved_back INTEGER NOT NULL DEFAULT 0, retained INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, CHECK (state IN ('planned','quarantined','completed','partial','failed')));";

fn cfg_conn() -> rusqlite::Connection {
    let c = rusqlite::Connection::open_in_memory().unwrap();
    c.execute_batch(GC_RUNS_DDL).unwrap();
    c
}

/// Create the config DB (`lataif_sync_server.db`) with the media_gc_runs table, so the boot-path audit
/// (`execute_pending_gc` / `reconcile`) has somewhere to record. Mirrors the real v0018 schema.
fn make_config_db(base: &std::path::Path) {
    let c = rusqlite::Connection::open(base.join("lataif_sync_server.db")).unwrap();
    c.execute_batch(GC_RUNS_DDL).unwrap();
}

/// Read a run's (state, quarantined, purged, moved_back, retained, failed) from the config DB.
fn run_row(base: &std::path::Path, run_id: &str) -> Option<(String, i64, i64, i64, i64, i64)> {
    let c = rusqlite::Connection::open(base.join("lataif_sync_server.db")).ok()?;
    c.query_row(
        "SELECT state,quarantined,purged,moved_back,retained,failed FROM media_gc_runs WHERE run_id=?1",
        [run_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
    ).ok()
}

fn root_of(base: &std::path::Path) -> std::path::PathBuf {
    let r = base.join("media");
    std::fs::create_dir_all(&r).unwrap();
    r
}

fn qcount(root: &std::path::Path) -> usize {
    let canon = super::super::storage::ensure_root_canonical(root).unwrap();
    quarantined_entries(&canon).len()
}

// ── reference set spans EVERY generation: a pinned/old (non-current) generation blob is NEVER an orphan ──
#[test]
fn dry_run_keeps_every_tracked_generation_flags_only_true_orphans() {
    let base = tmp();
    let root = root_of(&base);
    let (cur_rel, _, _) = put_media(&root, "tenant-1", b"CURRENT-GEN");
    let (old_rel, _, _) = put_media(&root, "tenant-1", b"PINNED-OLD-GEN"); // a non-current gen, still on disk
    let (orph_rel, _, osize) = put_media(&root, "tenant-1", b"TRULY-ORPHANED");
    // both generations are tracked (current + old pin); the orphan has NO row
    make_front(&base, &[&cur_rel, &old_rel]);
    let rep = plan(&base).unwrap();
    ok_eq(rep.referenced_count, 2, "both current + pinned-old generations are referenced");
    ok_eq(rep.orphan_count, 1, "only the untracked file is an orphan");
    assert_eq!(rep.orphans[0].rel_path, orph_rel);
    assert_eq!(rep.orphans[0].byte_size, osize);
    let _ = (cur_rel, old_rel);
}

fn ok_eq(a: usize, b: usize, m: &str) { assert_eq!(a, b, "{}", m); }

// ── fail-closed: an unreadable / schema-less reference DB deletes NOTHING ─────────────────────────
#[test]
fn fail_closed_without_reference_db() {
    let base = tmp();
    let root = root_of(&base);
    let (_r, _h, _s) = put_media(&root, "tenant-1", b"WOULD-BE-ORPHAN");
    assert!(plan(&base).is_err(), "plan fail-closed without a media_blob_generations table");
    super::write_intent(&base, "run-x").unwrap();
    assert!(execute_pending_gc(&base).is_err(), "boot move fail-closed on an unbuildable reference set");
    assert_eq!(scan_files(&super::super::storage::ensure_root_canonical(&root).unwrap()).unwrap().len(), 1, "orphan still present");
}

// ── schedule refuses without a snapshot / while a restore is pending; writes an intent otherwise ──
#[test]
fn schedule_guards_and_intent() {
    let base = tmp();
    let _root = root_of(&base);
    make_front(&base, &[]);
    let cfg = cfg_conn();
    // no snapshot → refuse
    let e = schedule(&base, &cfg, "r1", "t").unwrap_err();
    assert!(matches!(e, MediaError::Io(ref m) if m.contains("no backup snapshot")));
    // restore pending → refuse
    super::super::restore_recovery::write_intent(&base, "snap").unwrap();
    let e = schedule(&base, &cfg, "r2", "t").unwrap_err();
    assert!(matches!(e, MediaError::Io(ref m) if m.contains("restore pending")));
    // direct intent write is what the boot path consumes
    super::write_intent(&base, "run-1").unwrap();
    assert_eq!(read_intent(&base).as_deref(), Some("run-1"));
}

// ── boot move quarantines the orphan, RETAINS it (no purge), and clears the intent (exactly once) ──
#[test]
fn boot_move_quarantines_and_retains_no_purge() {
    let base = tmp();
    let root = root_of(&base);
    let (ref_rel, _, _) = put_media(&root, "tenant-1", b"ACTIVE");
    let (orph_rel, _, _) = put_media(&root, "tenant-1", b"ORPHAN");
    make_front(&base, &[&ref_rel]);
    super::write_intent(&base, "run-1").unwrap();
    let rep = execute_pending_gc(&base).unwrap().unwrap();
    assert_eq!(rep.quarantined, 1);
    assert!(!root.join(&orph_rel).exists(), "orphan moved out of the media path");
    assert!(root.join(&ref_rel).exists(), "referenced file untouched");
    assert!(root.join(QUARANTINE_DIRNAME).exists(), "quarantine is RETAINED (not purged this run)");
    assert_eq!(qcount(&root), 1, "one file awaits owner finalize");
    assert!(read_intent(&base).is_none(), "intent cleared → runs exactly once");
    // a second boot move is a no-op (no intent)
    assert!(execute_pending_gc(&base).unwrap().is_none());
    assert_eq!(qcount(&root), 1, "still retained after another boot");
}

// ── reconcile moves BACK a quarantined file that became referenced again; retains the rest ───────
#[test]
fn reconcile_moves_back_newly_referenced_and_retains() {
    let base = tmp();
    let root = root_of(&base);
    let (orph_rel, _, _) = put_media(&root, "tenant-1", b"WAS-ORPHAN-NOW-REFERENCED");
    let (other_rel, _, _) = put_media(&root, "tenant-1", b"STILL-ORPHAN");
    make_front(&base, &[]); // nothing referenced yet
    super::write_intent(&base, "run-1").unwrap();
    execute_pending_gc(&base).unwrap();
    assert_eq!(qcount(&root), 2, "both quarantined");
    // now a record references the first file again (e.g. a concurrent ingest linked it)
    make_front(&base, &[&orph_rel]);
    let rep = reconcile_quarantine(&base).unwrap();
    assert_eq!(rep.moved_back, 1);
    assert_eq!(rep.retained, 1);
    assert!(root.join(&orph_rel).exists(), "newly-referenced file was moved back to the media root");
    assert_eq!(qcount(&root), 1, "the still-orphan is retained, never blind-deleted");
    let _ = other_rel;
}

// ── reconcile is deferred while a restore is pending (a restore must not overlap GC) ─────────────
#[test]
fn reconcile_deferred_while_restore_pending() {
    let base = tmp();
    let root = root_of(&base);
    let (orph_rel, _, _) = put_media(&root, "tenant-1", b"ORPHAN");
    make_front(&base, &[]);
    super::write_intent(&base, "run-1").unwrap();
    execute_pending_gc(&base).unwrap();
    super::super::restore_recovery::write_intent(&base, "snap").unwrap();
    let rep = reconcile_quarantine(&base).unwrap();
    assert_eq!(rep.moved_back, 0);
    assert_eq!(rep.retained, 0, "reconcile is a no-op while a restore is pending");
    assert_eq!(qcount(&root), 1, "quarantine preserved");
    let _ = orph_rel;
}

// ── FINALIZE is the only permanent deletion: purges retained orphans, moves back now-referenced ──
#[test]
fn finalize_purges_only_after_recheck() {
    let base = tmp();
    let root = root_of(&base);
    let (a_rel, _, _) = put_media(&root, "tenant-1", b"ORPHAN-A");
    let (b_rel, _, _) = put_media(&root, "tenant-1", b"ORPHAN-B");
    make_front(&base, &[]);
    super::write_intent(&base, "run-1").unwrap();
    execute_pending_gc(&base).unwrap();
    assert_eq!(qcount(&root), 2);
    // between quarantine and finalize, B became referenced again → must be moved back, only A purged
    make_front(&base, &[&b_rel]);
    let cfg = cfg_conn();
    let rep = finalize(&base, &cfg, "2026-08-06T00:00:00Z").unwrap();
    assert_eq!(rep.purged, 1, "only the still-orphan A is purged");
    assert_eq!(rep.moved_back, 1, "B was moved back, never deleted");
    assert!(root.join(&b_rel).exists(), "B restored to the media root");
    assert!(!root.join(QUARANTINE_DIRNAME).exists(), "quarantine cleared after finalize");
    let _ = a_rel;
}

// ── happy path: the REAL run_id threads boot-move → finalize; statuses planned→quarantined→completed ──
#[test]
fn run_id_threads_through_and_status_is_accurate() {
    let base = tmp();
    let root = root_of(&base);
    let (_orph, _, _) = put_media(&root, "tenant-1", b"ORPHAN");
    make_front(&base, &[]);
    make_config_db(&base);
    super::write_intent(&base, "run-42").unwrap();
    let mv = execute_pending_gc(&base).unwrap().unwrap();
    assert_eq!(mv.run_id, "run-42");
    let q = run_row(&base, "run-42").expect("quarantined row recorded");
    assert_eq!(q.0, "quarantined");
    assert_eq!(q.1, 1, "quarantined count persisted"); // quarantined=1
    // finalize under the SAME run_id → completed
    let cfg = rusqlite::Connection::open(base.join("lataif_sync_server.db")).unwrap();
    finalize(&base, &cfg, "2026-08-06T00:00:00Z").unwrap();
    let f = run_row(&base, "run-42").expect("row still under the SAME run_id");
    assert_eq!(f.0, "completed");
    assert_eq!(f.2, 1, "purged count persisted"); // purged=1
    // no synthetic finalize-<now> run id was ever written
    let synthetic: i64 = cfg.query_row("SELECT COUNT(*) FROM media_gc_runs WHERE run_id LIKE 'finalize-%'", [], |r| r.get(0)).unwrap();
    assert_eq!(synthetic, 0, "no synthetic finalize-<now> run id");
}

// ── an empty run (no orphans) is `completed` immediately, not left as a dangling quarantine ──────
#[test]
fn empty_run_is_completed_not_quarantined() {
    let base = tmp();
    let root = root_of(&base);
    let (r, _, _) = put_media(&root, "tenant-1", b"REFERENCED");
    make_front(&base, &[&r]);
    make_config_db(&base);
    super::write_intent(&base, "run-empty").unwrap();
    let mv = execute_pending_gc(&base).unwrap().unwrap();
    assert_eq!(mv.quarantined, 0);
    assert_eq!(run_row(&base, "run-empty").unwrap().0, "completed");
    assert!(!root.join(QUARANTINE_DIRNAME).exists(), "no dangling quarantine for an empty run");
}

// ── reconcile keeps the SAME run_id and records the move-back ────────────────────────────────────
#[test]
fn reconcile_records_under_the_same_run_id() {
    let base = tmp();
    let root = root_of(&base);
    let (orph, _, _) = put_media(&root, "tenant-1", b"WILL-BE-REFERENCED");
    make_front(&base, &[]);
    make_config_db(&base);
    super::write_intent(&base, "run-recon").unwrap();
    execute_pending_gc(&base).unwrap();
    make_front(&base, &[&orph]); // now referenced
    reconcile_quarantine(&base).unwrap();
    let row = run_row(&base, "run-recon").expect("same run id after reconcile");
    assert_eq!(row.0, "completed", "run fully moved back → completed");
    assert_eq!(row.3, 1, "moved_back persisted"); // moved_back=1
    assert!(root.join(&orph).exists(), "moved back to the media root");
}

// ── PARTIAL delete: a blocked file → status `partial`, purged>0, the file stays visible ─────────
#[cfg(windows)]
#[test]
fn partial_delete_is_recorded_and_file_stays() {
    use std::os::windows::fs::OpenOptionsExt;
    let base = tmp();
    let root = root_of(&base);
    put_media(&root, "tenant-1", b"ORPHAN-A");
    put_media(&root, "tenant-1", b"ORPHAN-B-BLOCKED");
    make_front(&base, &[]);
    make_config_db(&base);
    super::write_intent(&base, "run-part").unwrap();
    execute_pending_gc(&base).unwrap();
    let canon = super::super::storage::ensure_root_canonical(&root).unwrap();
    let entries = quarantine_runs(&canon).into_iter().flat_map(|(_, f)| f).collect::<Vec<_>>();
    assert_eq!(entries.len(), 2);
    // hold ONE quarantined file open with FILE_SHARE_READ only → its remove_file fails.
    let blocked = &entries[0].1;
    let _lock = std::fs::OpenOptions::new().read(true).share_mode(1).open(blocked).unwrap();
    let cfg = rusqlite::Connection::open(base.join("lataif_sync_server.db")).unwrap();
    let rep = finalize(&base, &cfg, "t").unwrap();
    assert_eq!(rep.purged, 1);
    assert_eq!(rep.failed, 1);
    assert_eq!(run_row(&base, "run-part").unwrap().0, "partial", "partial delete → partial status");
    assert!(blocked.exists(), "the un-purged file stays in the quarantine (visible via scan)");
    assert_eq!(plan(&base).unwrap().quarantined_count, 1, "scan still shows the retained file");
}

// ── TOTAL failure: the only file blocked → status `failed`, nothing purged ───────────────────────
#[cfg(windows)]
#[test]
fn total_failure_is_recorded_as_failed() {
    use std::os::windows::fs::OpenOptionsExt;
    let base = tmp();
    let root = root_of(&base);
    put_media(&root, "tenant-1", b"ONLY-ORPHAN");
    make_front(&base, &[]);
    make_config_db(&base);
    super::write_intent(&base, "run-fail").unwrap();
    execute_pending_gc(&base).unwrap();
    let canon = super::super::storage::ensure_root_canonical(&root).unwrap();
    let blocked = quarantine_runs(&canon).into_iter().flat_map(|(_, f)| f).next().unwrap().1;
    let _lock = std::fs::OpenOptions::new().read(true).share_mode(1).open(&blocked).unwrap();
    let cfg = rusqlite::Connection::open(base.join("lataif_sync_server.db")).unwrap();
    let rep = finalize(&base, &cfg, "t").unwrap();
    assert_eq!(rep.purged, 0);
    assert_eq!(rep.failed, 1);
    assert_eq!(run_row(&base, "run-fail").unwrap().0, "failed", "total failure → failed status");
    assert!(blocked.exists());
}

// ── finalize refuses while a restore/backup is pending (no purge during those) ───────────────────
#[test]
fn finalize_refused_while_restore_pending() {
    let base = tmp();
    let root = root_of(&base);
    put_media(&root, "tenant-1", b"ORPHAN");
    make_front(&base, &[]);
    make_config_db(&base);
    super::write_intent(&base, "run-1").unwrap();
    execute_pending_gc(&base).unwrap();
    super::super::restore_recovery::write_intent(&base, "snap").unwrap();
    let cfg = rusqlite::Connection::open(base.join("lataif_sync_server.db")).unwrap();
    assert!(finalize(&base, &cfg, "t").is_err(), "finalize refuses while a restore is pending");
    assert_eq!(qcount(&root), 1, "quarantine preserved");
}

// ── control state (.ingest-journal) + the quarantine dir are never scanned as orphans ────────────
#[test]
fn control_dirs_are_never_orphans() {
    let base = tmp();
    let root = root_of(&base);
    let j = root.join(".ingest-journal");
    std::fs::create_dir_all(&j).unwrap();
    std::fs::write(j.join("t__abcd.json"), b"IN-FLIGHT").unwrap();
    std::fs::create_dir_all(root.join(QUARANTINE_DIRNAME).join("old")).unwrap();
    std::fs::write(root.join(QUARANTINE_DIRNAME).join("old").join("x.jpg"), b"Q").unwrap();
    make_front(&base, &[]);
    let rep = plan(&base).unwrap();
    assert_eq!(rep.orphan_count, 0, "neither .ingest-journal nor .gc-quarantine is ever an orphan");
    assert!(j.join("t__abcd.json").exists());
}

// ── §Windows junction: a junction to an external sentinel is never followed by the move ──────────
#[cfg(windows)]
#[test]
fn move_never_follows_a_junction_to_a_sentinel() {
    let base = tmp();
    let root = root_of(&base);
    let sentinel = tmp();
    std::fs::write(sentinel.join("keep.txt"), b"DO-NOT-DELETE").unwrap();
    let (orph_rel, _, _) = put_media(&root, "tenant-1", b"REAL-ORPHAN");
    let deep = root.join("tenant-1").join("de");
    std::fs::create_dir_all(&deep).unwrap();
    let link = deep.join("linkdir");
    assert!(std::process::Command::new("cmd").args(["/C", "mklink", "/J", link.to_str().unwrap(), sentinel.to_str().unwrap()]).status().unwrap().success());
    make_front(&base, &[]);
    super::write_intent(&base, "rj").unwrap();
    let rep = execute_pending_gc(&base).unwrap().unwrap();
    assert_eq!(rep.quarantined, 1, "only the real orphan is quarantined");
    assert!(!root.join(&orph_rel).exists());
    assert!(sentinel.join("keep.txt").exists(), "external sentinel behind the junction is untouched");
}

// ── §Windows: a quarantine run dir that is a junction is skipped by reconcile/finalize (no follow) ──
#[cfg(windows)]
#[test]
fn quarantine_run_junction_is_not_followed() {
    let base = tmp();
    let root = root_of(&base);
    let sentinel = tmp();
    std::fs::write(sentinel.join("keep.txt"), b"DO-NOT-DELETE").unwrap();
    let qroot = root.join(QUARANTINE_DIRNAME);
    std::fs::create_dir_all(&qroot).unwrap();
    let link = qroot.join("run-evil");
    assert!(std::process::Command::new("cmd").args(["/C", "mklink", "/J", link.to_str().unwrap(), sentinel.to_str().unwrap()]).status().unwrap().success());
    make_front(&base, &[]);
    let cfg = cfg_conn();
    finalize(&base, &cfg, "t").unwrap();
    assert!(sentinel.join("keep.txt").exists(), "a junction run dir is never followed/deleted");
}
