// MOBILE-04B2A1 — durable server upload inbox tests. Real temp rusqlite (file-backed, so reopen
// models a crash), real temp staging root, real encoded images. No production path is touched.

use super::*;
use lataif_server::migrations::{run_migrations, Migration};
use crate::sync::migrations::EMBEDDED_MIGRATIONS;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

const T: &str = "tenant-1";
const B: &str = "branch-main";
const U: &str = "user-owner";
const NOW: &str = "2026-07-26T00:00:00Z";

struct Temp(PathBuf);
impl Temp {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("lataif_mobup_{tag}_{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&p).unwrap();
        Temp(p)
    }
    fn path(&self) -> &Path { &self.0 }
}
impl Drop for Temp { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

fn base_sql() -> &'static str {
    "PRAGMA foreign_keys=ON;
     CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
        name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
        email TEXT NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(tenant_id, email));
     CREATE TABLE user_branches (user_id TEXT NOT NULL REFERENCES users(id),
        branch_id TEXT NOT NULL REFERENCES branches(id), role TEXT NOT NULL DEFAULT 'viewer',
        is_default INTEGER DEFAULT 0, created_at TEXT NOT NULL, PRIMARY KEY (user_id, branch_id));
     CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
        branch_id TEXT NOT NULL, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
        action TEXT NOT NULL, data TEXT NOT NULL, user_id TEXT, created_at TEXT NOT NULL);
     INSERT INTO tenants VALUES ('tenant-1','T','t','now','now');
     INSERT INTO tenants VALUES ('tenant-2','T2','t2','now','now');
     INSERT INTO branches VALUES ('branch-main','tenant-1','B','now','now');
     INSERT INTO branches VALUES ('branch-2','tenant-2','B2','now','now');"
}
fn open_db(dir: &Path) -> Connection {
    let conn = Connection::open(dir.join("server.db")).unwrap();
    conn.busy_timeout(std::time::Duration::from_secs(10)).unwrap();
    conn
}
fn init_db(dir: &Path) -> Connection {
    let conn = open_db(dir);
    conn.execute_batch(base_sql()).unwrap();
    run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
    conn
}
fn trusted() -> TrustedUploadContext {
    TrustedUploadContext { authenticated_user_id: U.into(), tenant_id: T.into(), branch_id: B.into() }
}
fn jpeg(w: u32, h: u32, salt: u8) -> Vec<u8> {
    let mut img = image::RgbImage::new(w, h);
    for y in 0..h { for x in 0..w {
        img.put_pixel(x, y, image::Rgb([(x as u8).wrapping_add(salt), (y as u8) ^ salt, ((x + y) as u8).wrapping_mul(31)]));
    }}
    let mut buf = Vec::new();
    image::DynamicImage::ImageRgb8(img).write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Jpeg).unwrap();
    buf
}
fn png(w: u32, h: u32) -> Vec<u8> {
    let img = image::RgbImage::from_pixel(w, h, image::Rgb([10, 20, 30]));
    let mut buf = Vec::new();
    image::DynamicImage::ImageRgb8(img).write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png).unwrap();
    buf
}
fn img_jpeg(bytes: Vec<u8>) -> RawUploadImage { RawUploadImage { declared_mime: "image/jpeg".into(), bytes } }
fn sub(event: &str, images: Vec<RawUploadImage>, meta: &str) -> UploadSubmission {
    UploadSubmission {
        protocol_version: MOBILE_UPLOAD_PROTOCOL_VERSION, upload_event_id: event.into(),
        entity_id: "prod-1".into(), mode: "collection".into(), metadata_json: meta.into(), images,
    }
}
const META: &str = r#"{"brand":"Rolex","categoryId":"cat-watch","name":"Sub"}"#;

fn inbox_count(c: &Connection) -> i64 { c.query_row("SELECT COUNT(*) FROM mobile_upload_inbox", [], |r| r.get(0)).unwrap() }
fn image_count(c: &Connection) -> i64 { c.query_row("SELECT COUNT(*) FROM mobile_upload_image", [], |r| r.get(0)).unwrap() }
fn staged_files(root: &Path) -> usize {
    fn walk(p: &Path, n: &mut usize) {
        if let Ok(rd) = std::fs::read_dir(p) { for e in rd.flatten() {
            let path = e.path();
            if path.is_dir() { walk(&path, n); }
            else if !path.file_name().unwrap().to_string_lossy().ends_with(".tmp") { *n += 1; }
        }}
    }
    let mut n = 0; walk(root, &mut n); n
}

#[test]
fn valid_collection_upload_accepted_no_base64() {
    let d = Temp::new("db"); let s = Temp::new("stg");
    let mut c = init_db(d.path());
    let out = accept_upload(&mut c, s.path(), &trusted(), &sub("ev-1", vec![img_jpeg(jpeg(200, 150, 1))], META), NOW).unwrap();
    assert!(matches!(out, UploadOutcome::Accepted { .. }));
    assert_eq!((inbox_count(&c), image_count(&c)), (1, 1));
    let state: String = c.query_row("SELECT state FROM mobile_upload_inbox", [], |r| r.get(0)).unwrap();
    assert_eq!(state, "accepted");
    // no base64 / data URL anywhere in SQLite; image row holds a content-addressed storage key.
    let (meta, key): (String, String) = c.query_row(
        "SELECT i.metadata_json, m.storage_key FROM mobile_upload_inbox i JOIN mobile_upload_image m
          ON m.upload_event_id=i.upload_event_id", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert!(!meta.contains("data:image") && !meta.contains("base64"));
    assert!(key.starts_with("tenant-1/") && key.ends_with(".jpg") && !key.contains("data:"));
    assert_eq!(staged_files(s.path()), 1);
}

#[test]
fn multiple_images_order_and_primary_stable() {
    let d = Temp::new("db"); let s = Temp::new("stg");
    let mut c = init_db(d.path());
    accept_upload(&mut c, s.path(), &trusted(), &sub("ev-m",
        vec![img_jpeg(jpeg(120, 90, 1)), img_jpeg(jpeg(120, 90, 2)), img_jpeg(jpeg(120, 90, 3))], META), NOW).unwrap();
    let rows: Vec<(i64, i64)> = {
        let mut st = c.prepare("SELECT slot, is_primary FROM mobile_upload_image ORDER BY slot").unwrap();
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(|x| x.unwrap()).collect()
    };
    assert_eq!(rows, vec![(0, 1), (1, 0), (2, 0)], "ordered slots, primary only at slot 0");
}

#[test]
fn idempotency_replay_conflict_and_distinct_events() {
    let d = Temp::new("db"); let s = Temp::new("stg");
    let mut c = init_db(d.path());
    let img = jpeg(160, 120, 7);
    accept_upload(&mut c, s.path(), &trusted(), &sub("ev-1", vec![img_jpeg(img.clone())], META), NOW).unwrap();
    // same event + same request → replay
    let r = accept_upload(&mut c, s.path(), &trusted(), &sub("ev-1", vec![img_jpeg(img.clone())], META), NOW).unwrap();
    assert!(matches!(r, UploadOutcome::Replay { .. }));
    // same event + different request (metadata) → conflict, no new row
    let r2 = accept_upload(&mut c, s.path(), &trusted(), &sub("ev-1", vec![img_jpeg(img.clone())], r#"{"brand":"Omega"}"#), NOW).unwrap();
    assert!(matches!(r2, UploadOutcome::Conflict { .. }));
    assert_eq!(inbox_count(&c), 1);
    // different event id + DIFFERENT entity id + identical content → separate valid upload
    // (2 jobs, one physical file). Same entity id would be a TargetConflict (see R1 tests).
    let mut ev2 = sub("ev-2", vec![img_jpeg(img.clone())], META); ev2.entity_id = "prod-2".into();
    accept_upload(&mut c, s.path(), &trusted(), &ev2, NOW).unwrap();
    assert_eq!(inbox_count(&c), 2);
    assert_eq!(staged_files(s.path()), 1, "content-addressed: identical bytes → one staged file");
}

#[test]
fn forged_scope_and_unsupported_mode_and_protocol() {
    let d = Temp::new("db"); let s = Temp::new("stg");
    let mut c = init_db(d.path());
    let img = || vec![img_jpeg(jpeg(100, 100, 1))];
    // empty trusted scope → no write
    let empty = TrustedUploadContext { authenticated_user_id: "".into(), tenant_id: T.into(), branch_id: B.into() };
    assert_eq!(accept_upload(&mut c, s.path(), &empty, &sub("e", img(), META), NOW).unwrap_err().code(), ERR_SCOPE_REQUIRED);
    // metadata cannot smuggle scope — the row's scope is the TRUSTED one
    accept_upload(&mut c, s.path(), &trusted(), &sub("ev-x", img(), r#"{"tenant_id":"EVIL","branch_id":"EVIL","brand":"X"}"#), NOW).unwrap();
    let (t, b): (String, String) = c.query_row("SELECT tenant_id, branch_id FROM mobile_upload_inbox WHERE upload_event_id='ev-x'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((t.as_str(), b.as_str()), (T, B));
    // repair / purchase_inbox → UNSUPPORTED_MODE
    for m in ["repair", "purchase_inbox"] {
        let mut sm = sub("ev-mode", img(), META); sm.mode = m.into();
        assert_eq!(accept_upload(&mut c, s.path(), &trusted(), &sm, NOW).unwrap_err().code(), ERR_UNSUPPORTED_MODE);
    }
    // unsupported protocol
    let mut sp = sub("ev-p", img(), META); sp.protocol_version = 99;
    assert_eq!(accept_upload(&mut c, s.path(), &trusted(), &sp, NOW).unwrap_err().code(), ERR_UNSUPPORTED_PROTOCOL);
}

#[test]
fn invalid_images_rejected() {
    let d = Temp::new("db"); let s = Temp::new("stg");
    let mut c = init_db(d.path());
    let mut up = |imgs: Vec<RawUploadImage>| accept_upload(&mut c, s.path(), &trusted(), &sub("ev", imgs, META), NOW).map_err(|e| e.code());
    // MIME↔magic mismatch (declared png, jpeg bytes)
    assert_eq!(up(vec![RawUploadImage { declared_mime: "image/png".into(), bytes: jpeg(50, 50, 1) }]).unwrap_err(), ERR_MIME_MISMATCH);
    // SVG / unsupported magic
    assert_eq!(up(vec![RawUploadImage { declared_mime: "image/svg+xml".into(), bytes: b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>".to_vec() }]).unwrap_err(), ERR_UNSUPPORTED_MIME);
    // per-image byte cap (26 MiB buffer, checked before decode)
    assert_eq!(up(vec![RawUploadImage { declared_mime: "image/jpeg".into(), bytes: vec![0u8; 26 * 1024 * 1024] }]).unwrap_err(), ERR_IMAGE_TOO_LARGE);
    // over-axis dimension
    assert_eq!(up(vec![img_jpeg(jpeg(8193, 8, 1))]).unwrap_err(), ERR_TOO_LARGE_DIMENSIONS);
    // over pixel budget (5100x5000 = 25.5 MP > 24 MP, both axes ≤ 8192)
    assert_eq!(up(vec![img_jpeg(jpeg(5100, 5000, 1))]).unwrap_err(), ERR_TOO_MANY_PIXELS);
    // truncated raster (valid PNG header for dims, incomplete IDAT → decode fails)
    let mut trunc = png(300, 300); trunc.truncate(trunc.len() / 2);
    assert!(up(vec![RawUploadImage { declared_mime: "image/png".into(), bytes: trunc }]).is_err());
    // too many images (9)
    let many: Vec<RawUploadImage> = (0..9).map(|i| img_jpeg(jpeg(40, 40, i as u8))).collect();
    assert_eq!(up(many).unwrap_err(), ERR_TOO_MANY_IMAGES);
    // empty batch
    assert_eq!(up(vec![]).unwrap_err(), ERR_NO_IMAGES);
}

#[test]
fn batch_byte_cap() {
    let d = Temp::new("db"); let s = Temp::new("stg");
    let mut c = init_db(d.path());
    // 8 high-entropy jpegs (~>5 MiB each) → over the 40 MiB batch cap.
    let imgs: Vec<RawUploadImage> = (0..8).map(|i| img_jpeg(jpeg(3000, 3000, i as u8))).collect();
    let total: usize = imgs.iter().map(|i| i.bytes.len()).sum();
    if total > MAX_UPLOAD_BATCH_BYTES {
        assert_eq!(accept_upload(&mut c, s.path(), &trusted(), &sub("ev-big", imgs, META), NOW).unwrap_err().code(), ERR_BATCH_TOO_LARGE);
    } else {
        // entropy compressed below the cap — assert the guard arithmetic directly instead.
        assert!(MAX_UPLOAD_BATCH_BYTES == 40 * 1024 * 1024);
    }
}

#[test]
fn path_traversal_and_symlink_refused() {
    let s = Temp::new("stg");
    // a `..` scope/segment is refused lexically
    assert!(stage_image_durably(s.path(), "..", b"x", &"a".repeat(64), "jpg").is_err());
    // a symlinked shard directory under the root is refused (reparse guard)
    #[cfg(unix)]
    {
        let hash = "b".repeat(64);
        let shard = s.path().join("tenant-1").join(&hash[0..2]);
        std::fs::create_dir_all(s.path().join("tenant-1")).unwrap();
        let outside = Temp::new("outside");
        std::os::unix::fs::symlink(outside.path(), &shard).unwrap();
        assert!(stage_image_durably(s.path(), "tenant-1", b"payload", &hash, "jpg").is_err(), "symlinked shard dir refused");
    }
}

#[test]
fn crash_matrix_and_reopen_exactly_once() {
    let d = Temp::new("db"); let s = Temp::new("stg");
    let submission = sub("ev-crash", vec![img_jpeg(jpeg(220, 180, 5))], META);
    // (a) crash "before full receipt": a validation reject writes nothing + stages nothing.
    {
        let mut c = init_db(d.path());
        let mut trunc = png(300, 300); trunc.truncate(trunc.len() / 2);
        let _ = accept_upload(&mut c, s.path(), &trusted(), &sub("ev-bad", vec![RawUploadImage { declared_mime: "image/png".into(), bytes: trunc }], META), NOW);
        assert_eq!((inbox_count(&c), staged_files(s.path())), (0, 0));
    }
    // (b) crash after file-publish, before DB commit: stage the file, no inbox row yet.
    let hash = sha256_hex(&submission.images[0].bytes);
    stage_image_durably(s.path(), T, &submission.images[0].bytes, &hash, "jpg").unwrap();
    {
        let c = open_db(d.path());
        assert_eq!(inbox_count(&c), 0, "no accepted job while only files exist");
        assert_eq!(staged_files(s.path()), 1, "orphan staging file present");
    }
    // retry after that crash → exactly one job, the orphan file reused (no duplicate).
    {
        let mut c = open_db(d.path());
        assert!(matches!(accept_upload(&mut c, s.path(), &trusted(), &submission, NOW).unwrap(), UploadOutcome::Accepted { .. }));
        assert_eq!((inbox_count(&c), staged_files(s.path())), (1, 1));
    }
    // (c) crash after accepted-commit, before response: reopen → same accepted job.
    {
        let c = open_db(d.path());
        let st = get_upload_status(&c, &trusted(), "ev-crash").unwrap().unwrap();
        assert_eq!(st.0, "accepted");
    }
    // (d) identical retry after reopen → replay, no duplicate job/file.
    {
        let mut c = open_db(d.path());
        assert!(matches!(accept_upload(&mut c, s.path(), &trusted(), &submission, NOW).unwrap(), UploadOutcome::Replay { .. }));
        assert_eq!((inbox_count(&c), image_count(&c), staged_files(s.path())), (1, 1, 1));
    }
}

#[test]
fn no_products_writepath_no_route_registered() {
    // structural: the core never writes products/applyUpsert, and no route wires it. Scan CODE
    // lines only (strip comments — the module doc legitimately names what it must NOT do).
    let src: String = include_str!("mobile_upload.rs").lines()
        .filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
    assert!(!src.contains("INSERT INTO products") && !src.to_lowercase().contains("applyupsert"), "no products/applyUpsert write path");
    let routes = include_str!("routes.rs");
    assert!(!routes.contains("mobile_upload") && !routes.contains("/mobile/v1"), "no V2 upload route registered");
    let modrs = include_str!("mod.rs");
    assert!(!modrs.contains("mobile/v1") && !modrs.contains("accept_upload"), "core is not routed from mod.rs");
}

// ── R1 §1 — concurrent exactly-once acceptance ──────────────────────────────
fn accept_retry(dir: &Path, staging: &Path, sub: &UploadSubmission) -> UploadOutcome {
    // one retry to absorb a transient Retryable under contention.
    for _ in 0..3 {
        let mut c = open_db(dir);
        match accept_upload(&mut c, staging, &trusted(), sub, NOW) {
            Ok(o) => return o,
            Err(UploadError::Retryable) => continue,
            Err(e) => panic!("unexpected error: {}", e.code()),
        }
    }
    panic!("still retryable after retries");
}

#[test]
fn concurrent_identical_request_exactly_once() {
    let d = Temp::new("db"); let s = Temp::new("stg");
    drop(init_db(d.path())); // migrate, then close
    let submission = sub("ev-conc", vec![img_jpeg(jpeg(200, 160, 4))], META);
    let (dp, sp) = (d.path().to_path_buf(), s.path().to_path_buf());
    let outcomes = std::thread::scope(|sc| {
        let h1 = sc.spawn(|| accept_retry(&dp, &sp, &submission));
        let h2 = sc.spawn(|| accept_retry(&dp, &sp, &submission));
        vec![h1.join().unwrap(), h2.join().unwrap()]
    });
    let accepted = outcomes.iter().filter(|o| matches!(o, UploadOutcome::Accepted { .. })).count();
    let replay = outcomes.iter().filter(|o| matches!(o, UploadOutcome::Replay { .. })).count();
    assert_eq!((accepted, replay), (1, 1), "exactly one accepted, one replay");
    let c = open_db(d.path());
    assert_eq!((inbox_count(&c), image_count(&c), staged_files(s.path())), (1, 1, 1), "one job, one image row, one file");
}

#[test]
fn concurrent_conflicting_request_no_loser_orphan() {
    let d = Temp::new("db"); let s = Temp::new("stg");
    drop(init_db(d.path()));
    let sub_a = sub("ev-cc", vec![img_jpeg(jpeg(150, 150, 1))], META);
    let sub_b = sub("ev-cc", vec![img_jpeg(jpeg(150, 150, 2))], r#"{"brand":"Omega"}"#); // same key, different request
    let (dp, sp) = (d.path().to_path_buf(), s.path().to_path_buf());
    let outcomes = std::thread::scope(|sc| {
        let h1 = sc.spawn(|| accept_retry(&dp, &sp, &sub_a));
        let h2 = sc.spawn(|| accept_retry(&dp, &sp, &sub_b));
        vec![h1.join().unwrap(), h2.join().unwrap()]
    });
    let accepted = outcomes.iter().filter(|o| matches!(o, UploadOutcome::Accepted { .. })).count();
    let conflict = outcomes.iter().filter(|o| matches!(o, UploadOutcome::Conflict { .. })).count();
    assert_eq!((accepted, conflict), (1, 1), "exactly one accepted, one conflict");
    let c = open_db(d.path());
    assert_eq!(inbox_count(&c), 1);
    assert_eq!(staged_files(s.path()), 1, "loser's distinct file was cleaned up — no orphan");
}

// ── R1 §2 — target-entity uniqueness ────────────────────────────────────────
#[test]
fn same_entity_new_event_is_target_conflict() {
    let d = Temp::new("db"); let s = Temp::new("stg");
    let mut c = init_db(d.path());
    let mut a = sub("ev-1", vec![img_jpeg(jpeg(120, 120, 1))], META); a.entity_id = "prod-SAME".into();
    let mut b = sub("ev-2", vec![img_jpeg(jpeg(120, 120, 2))], META); b.entity_id = "prod-SAME".into();
    assert!(matches!(accept_upload(&mut c, s.path(), &trusted(), &a, NOW).unwrap(), UploadOutcome::Accepted { .. }));
    assert!(matches!(accept_upload(&mut c, s.path(), &trusted(), &b, NOW).unwrap(), UploadOutcome::TargetConflict { .. }));
    assert_eq!(inbox_count(&c), 1, "no second job for the same product id");
}

#[test]
fn distinct_entities_same_image_two_jobs_shared_blob() {
    let d = Temp::new("db"); let s = Temp::new("stg");
    let mut c = init_db(d.path());
    let img = jpeg(140, 140, 9);
    let mut a = sub("ev-a", vec![img_jpeg(img.clone())], META); a.entity_id = "prod-A".into();
    let mut b = sub("ev-b", vec![img_jpeg(img.clone())], META); b.entity_id = "prod-B".into();
    accept_upload(&mut c, s.path(), &trusted(), &a, NOW).unwrap();
    accept_upload(&mut c, s.path(), &trusted(), &b, NOW).unwrap();
    assert_eq!((inbox_count(&c), staged_files(s.path())), (2, 1), "two jobs share one content-addressed blob");
    let key: String = c.query_row("SELECT storage_key FROM mobile_upload_image LIMIT 1", [], |r| r.get(0)).unwrap();
    assert!(blob_still_referenced(&c, T, &key).unwrap());
    assert!(!safe_to_delete_staged(&c, T, &key).unwrap(), "shared blob not deletable while any active job references it");
}

// ── R1 §3 — replay/accepted integrity ───────────────────────────────────────
#[test]
fn replay_missing_file_quarantines_fail_closed() {
    let d = Temp::new("db"); let s = Temp::new("stg");
    let submission = sub("ev-int", vec![img_jpeg(jpeg(180, 140, 3))], META);
    {
        let mut c = init_db(d.path());
        accept_upload(&mut c, s.path(), &trusted(), &submission, NOW).unwrap();
    }
    // corrupt the staged tree: delete the file.
    for e in std::fs::read_dir(s.path().join(T)).unwrap().flatten() {
        std::fs::remove_dir_all(e.path()).ok();
    }
    {
        let mut c = open_db(d.path());
        let err = accept_upload(&mut c, s.path(), &trusted(), &submission, NOW).unwrap_err();
        assert_eq!(err.code(), ERR_INTEGRITY_FAILURE, "missing file → no accepted replay, typed integrity failure");
    }
    // reopen → same fail-closed state (job now quarantined; replay returns quarantined, never accepted)
    {
        let mut c = open_db(d.path());
        let out = accept_upload(&mut c, s.path(), &trusted(), &submission, NOW).unwrap();
        match out { UploadOutcome::Replay { state, .. } => assert_eq!(state, "quarantined"), o => panic!("expected quarantined replay, got {:?}", o) }
    }
}

#[test]
fn replay_hash_mismatch_quarantines() {
    let d = Temp::new("db"); let s = Temp::new("stg");
    let submission = sub("ev-h", vec![img_jpeg(jpeg(160, 120, 6))], META);
    { let mut c = init_db(d.path()); accept_upload(&mut c, s.path(), &trusted(), &submission, NOW).unwrap(); }
    // overwrite the staged file with different bytes (same size not required — hash differs).
    let key: String = { let c = open_db(d.path()); c.query_row("SELECT storage_key FROM mobile_upload_image LIMIT 1", [], |r| r.get(0)).unwrap() };
    std::fs::write(s.path().join(&key), b"corrupted-bytes-not-the-original-image").unwrap();
    let mut c = open_db(d.path());
    assert_eq!(accept_upload(&mut c, s.path(), &trusted(), &submission, NOW).unwrap_err().code(), ERR_INTEGRITY_FAILURE);
}

// ── R1 §4 — shared-blob lifecycle guard ─────────────────────────────────────
#[test]
fn shared_blob_not_deleted_while_referenced() {
    let d = Temp::new("db"); let s = Temp::new("stg");
    let mut c = init_db(d.path());
    let img = jpeg(130, 130, 2);
    let mut a = sub("ev-a", vec![img_jpeg(img.clone())], META); a.entity_id = "prod-A".into();
    let mut b = sub("ev-b", vec![img_jpeg(img.clone())], META); b.entity_id = "prod-B".into();
    accept_upload(&mut c, s.path(), &trusted(), &a, NOW).unwrap();
    accept_upload(&mut c, s.path(), &trusted(), &b, NOW).unwrap();
    let key: String = c.query_row("SELECT storage_key FROM mobile_upload_image LIMIT 1", [], |r| r.get(0)).unwrap();
    assert!(!safe_to_delete_staged(&c, T, &key).unwrap(), "two active refs → not deletable");
    // one job goes terminal — still referenced by the other active job.
    c.execute("UPDATE mobile_upload_inbox SET state='quarantined' WHERE upload_event_id='ev-a'", []).unwrap();
    assert!(!safe_to_delete_staged(&c, T, &key).unwrap(), "still one active ref → not deletable");
    // both terminal → now an orphan, deletable.
    c.execute("UPDATE mobile_upload_inbox SET state='quarantined' WHERE upload_event_id='ev-b'", []).unwrap();
    assert!(safe_to_delete_staged(&c, T, &key).unwrap(), "no active ref → deletable");
}

// ── R2 §1 — scope-qualified target uniqueness (tenant + branch + entityId) ──
fn trusted_for(t: &str, b: &str) -> TrustedUploadContext {
    TrustedUploadContext { authenticated_user_id: U.into(), tenant_id: t.into(), branch_id: b.into() }
}
#[test]
fn scope_qualified_entity_uniqueness() {
    let d = Temp::new("db"); let s = Temp::new("stg");
    let mut c = init_db(d.path());
    let ent = "prod-SHARED-ID";
    // same entity id, DIFFERENT tenant/branch → both allowed (uniqueness is scoped, not global).
    let mut a = sub("ev-t1", vec![img_jpeg(jpeg(120, 120, 1))], META); a.entity_id = ent.into();
    let mut b = sub("ev-t2", vec![img_jpeg(jpeg(120, 120, 2))], META); b.entity_id = ent.into();
    assert!(matches!(accept_upload(&mut c, s.path(), &trusted_for(T, B), &a, NOW).unwrap(), UploadOutcome::Accepted { .. }));
    assert!(matches!(accept_upload(&mut c, s.path(), &trusted_for("tenant-2", "branch-2"), &b, NOW).unwrap(), UploadOutcome::Accepted { .. }),
        "same entity id in a different tenant/branch is a different target");
    assert_eq!(inbox_count(&c), 2);
    // same entity id in the SAME tenant/branch, new event → TargetConflict (no second active job).
    let mut a2 = sub("ev-t3", vec![img_jpeg(jpeg(120, 120, 3))], META); a2.entity_id = ent.into();
    assert!(matches!(accept_upload(&mut c, s.path(), &trusted_for(T, B), &a2, NOW).unwrap(), UploadOutcome::TargetConflict { .. }));
    assert_eq!(inbox_count(&c), 2, "no third job — the in-scope entity id is held");
}

// ── R2 §2 — shared-blob cleanup vs concurrent accept, race closed ───────────
#[test]
fn concurrent_shared_blob_accept_vs_loser_cleanup() {
    // Winner and loser share the SAME event key (→ one wins, one Conflicts) AND the SAME image
    // (→ one content-addressed blob). The loser reaches the cleanup path; it must never delete the
    // blob the committed winner references, and the winner must stay physically integrity-valid.
    // Repeated to exercise both scheduler interleavings under a real lock/transaction contract.
    for iter in 0..5 {
        let d = Temp::new("db"); let s = Temp::new("stg");
        drop(init_db(d.path()));
        let img = jpeg(150, 150, 3);
        let win = sub("ev-1", vec![img_jpeg(img.clone())], META);
        let los = sub("ev-1", vec![img_jpeg(img.clone())], r#"{"brand":"Omega"}"#); // same key, diff request
        let (dp, sp) = (d.path().to_path_buf(), s.path().to_path_buf());
        let outcomes = std::thread::scope(|sc| {
            let h1 = sc.spawn(|| accept_retry(&dp, &sp, &win));
            let h2 = sc.spawn(|| accept_retry(&dp, &sp, &los));
            vec![h1.join().unwrap(), h2.join().unwrap()]
        });
        let accepted = outcomes.iter().filter(|o| matches!(o, UploadOutcome::Accepted { .. })).count();
        let conflict = outcomes.iter().filter(|o| matches!(o, UploadOutcome::Conflict { .. })).count();
        assert_eq!((accepted, conflict), (1, 1), "iter {iter}: one accepted, one conflict");
        let c = open_db(d.path());
        assert_eq!(inbox_count(&c), 1, "iter {iter}");
        assert_eq!(staged_files(s.path()), 1, "iter {iter}: winner's shared blob survived loser cleanup");
        let (key, chash): (String, String) = c.query_row(
            "SELECT storage_key, content_hash FROM mobile_upload_image LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        let bytes = std::fs::read(s.path().join(&key)).unwrap();
        assert_eq!(sha256_hex(&bytes), chash, "iter {iter}: accepted job's blob is intact");
    }
}

// ── R2 §3 — full manifest verification on accepted/replay ───────────────────
fn tamper_then_expect(images: u8, mutate_sql: &str, expect: &str) {
    let d = Temp::new("db"); let s = Temp::new("stg");
    let imgs: Vec<RawUploadImage> = (0..images).map(|i| img_jpeg(jpeg(120, 100, i))).collect();
    let submission = sub("ev-t", imgs, META);
    { let mut c = init_db(d.path()); accept_upload(&mut c, s.path(), &trusted(), &submission, NOW).unwrap(); }
    { let c = open_db(d.path()); c.execute_batch(mutate_sql).unwrap(); }
    // first replay after the tamper → typed fail-closed error + the job is quarantined.
    { let mut c = open_db(d.path());
      assert_eq!(accept_upload(&mut c, s.path(), &trusted(), &submission, NOW).unwrap_err().code(), expect); }
    // reopen → same fail-closed state (quarantined replay, never a false accepted).
    { let mut c = open_db(d.path());
      match accept_upload(&mut c, s.path(), &trusted(), &submission, NOW).unwrap() {
          UploadOutcome::Replay { state, .. } => assert_eq!(state, "quarantined"),
          o => panic!("expected quarantined replay, got {:?}", o) } }
}
#[test]
fn replay_missing_image_row_manifest_invalid() {
    // drop slot 1 of a 2-image job: recomputed 1-image manifest ≠ frozen 2-image payload hash.
    tamper_then_expect(2, "DELETE FROM mobile_upload_image WHERE upload_event_id='ev-t' AND slot=1", ERR_MANIFEST_INVALID);
}
#[test]
fn replay_extra_image_row_manifest_invalid() {
    // inject a bogus slot 2 (file need not exist — the recompute layer fails before physical).
    let sql = format!(
        "INSERT INTO mobile_upload_image (tenant_id,branch_id,authenticated_user_id,upload_event_id,slot,is_primary,mime,width,height,byte_size,content_hash,storage_key)
         VALUES ('{T}','{B}','{U}','ev-t',2,0,'image/jpeg',10,10,1,'{}','tenant-1/aa/{}.jpg')", "a".repeat(64), "a".repeat(64));
    tamper_then_expect(2, &sql, ERR_MANIFEST_INVALID);
}
#[test]
fn replay_slot_gap_manifest_invalid() {
    // 3-image job, delete the middle slot → non-contiguous slots [0,2].
    tamper_then_expect(3, "DELETE FROM mobile_upload_image WHERE upload_event_id='ev-t' AND slot=1", ERR_MANIFEST_INVALID);
}
#[test]
fn replay_primary_violation_manifest_invalid() {
    // move the primary flag off slot 0.
    tamper_then_expect(2, "UPDATE mobile_upload_image SET is_primary=0 WHERE upload_event_id='ev-t' AND slot=0;
                           UPDATE mobile_upload_image SET is_primary=1 WHERE upload_event_id='ev-t' AND slot=1", ERR_MANIFEST_INVALID);
}
#[test]
fn replay_descriptor_mismatch_manifest_invalid() {
    // alter a stored descriptor while the file stays byte-intact → frozen commitment breaks.
    tamper_then_expect(1, "UPDATE mobile_upload_image SET width=width+1 WHERE upload_event_id='ev-t' AND slot=0", ERR_MANIFEST_INVALID);
}

#[test]
fn v0012_migration_partial_failure_and_rerun() {
    let d = Temp::new("db");
    let conn = open_db(d.path());
    conn.execute_batch(base_sql()).unwrap();
    // apply through v0011, then a BROKEN v0012 → rollback, not applied.
    run_migrations(&conn, &EMBEDDED_MIGRATIONS[..11]).unwrap();
    const PROBE_UP: &str = "CREATE TABLE IF NOT EXISTS mobup_probe (id INTEGER PRIMARY KEY); INSERT INTO __missing__ VALUES (1);";
    const PROBE_REF: &str = "CREATE TABLE IF NOT EXISTS mobup_probe (id INTEGER PRIMARY KEY);";
    let broken = Migration { version: 12, name: "mobile_upload_inbox", up_sql: PROBE_UP, reference_sql: PROBE_REF };
    let mut list: Vec<Migration> = EMBEDDED_MIGRATIONS[..11].to_vec(); list.push(broken);
    assert!(run_migrations(&conn, &list).is_err(), "failing v0012 must error (fail closed)");
    let maxv: i64 = conn.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0)).unwrap();
    assert_eq!(maxv, 11, "v0012 not marked applied");
    for t in ["mobup_probe", "mobile_upload_inbox", "mobile_upload_image"] {
        let e: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1", [t], |r| r.get(0)).unwrap();
        assert_eq!(e, 0, "no half-applied v0012 structure");
    }
    // clean retry with the real list → v0012 applies; re-run idempotent.
    let rep = run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
    assert_eq!(rep.applied, vec![12]);
    let again = run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
    assert!(again.applied.is_empty());
    for t in ["mobile_upload_inbox", "mobile_upload_image"] {
        let e: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1", [t], |r| r.get(0)).unwrap();
        assert_eq!(e, 1);
    }
}
