// BACKUP-LOCATION — resolver + config + validation contracts (headless).
use super::*;
use rusqlite::Connection;

fn tmp() -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    let n = format!(
        "lataif-bkloc-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    p.push(n);
    std::fs::create_dir_all(&p).unwrap();
    p
}

/// Build a config DB at `<app>/lataif_sync_server.db` with just the v0016 table (no full server schema).
fn config_db_with_table(app: &std::path::Path) -> Connection {
    let conn = Connection::open(app.join(CONFIG_DB)).unwrap();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS backup_location_config (
            tenant_id TEXT NOT NULL PRIMARY KEY,
            backup_root_path TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            updated_by TEXT);",
    )
    .unwrap();
    conn
}

#[test]
fn default_when_nothing_configured() {
    let app = tmp();
    // no config DB at all → default
    assert_eq!(resolve_root(&app), app.join("backups"));
    let info = current(&app);
    assert!(info.is_default);
    assert_eq!(info.path, app.join("backups").to_string_lossy());
    std::fs::remove_dir_all(&app).ok();
}

#[test]
fn default_when_table_present_but_empty() {
    let app = tmp();
    let _c = config_db_with_table(&app);
    assert_eq!(resolve_root(&app), app.join("backups"));
    assert!(current(&app).is_default);
    std::fs::remove_dir_all(&app).ok();
}

#[test]
fn set_get_reset_roundtrip() {
    let app = tmp();
    let conn = config_db_with_table(&app);
    let target = tmp(); // a real other absolute dir
    let tp = target.to_string_lossy().to_string();

    set_configured(&conn, &tp, "owner-1", "2026-08-03T00:00:00Z").unwrap();
    drop(conn);

    // resolver now returns the configured path; current() reports non-default
    assert_eq!(resolve_root(&app), std::path::PathBuf::from(&tp));
    let info = current(&app);
    assert!(!info.is_default);
    assert_eq!(info.path, tp);
    assert_eq!(info.default_path, app.join("backups").to_string_lossy());

    // reset → default again
    let conn = config_db_with_table(&app);
    clear_configured(&conn).unwrap();
    drop(conn);
    assert_eq!(resolve_root(&app), app.join("backups"));
    assert!(current(&app).is_default);

    std::fs::remove_dir_all(&app).ok();
    std::fs::remove_dir_all(&target).ok();
}

#[test]
fn set_is_idempotent_replace() {
    let app = tmp();
    let conn = config_db_with_table(&app);
    let a = tmp();
    let b = tmp();
    set_configured(&conn, &a.to_string_lossy(), "o", "t1").unwrap();
    set_configured(&conn, &b.to_string_lossy(), "o", "t2").unwrap();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM backup_location_config", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1, "one row per tenant (replace, not append)");
    drop(conn);
    assert_eq!(resolve_root(&app), b);
    std::fs::remove_dir_all(&app).ok();
    std::fs::remove_dir_all(&a).ok();
    std::fs::remove_dir_all(&b).ok();
}

#[test]
fn validate_rejects_relative_and_empty() {
    let app = tmp();
    assert_eq!(validate_and_prepare(&app, ""), Err(MediaError::BackupLocationNotAbsolute));
    assert_eq!(validate_and_prepare(&app, "relative/dir"), Err(MediaError::BackupLocationNotAbsolute));
    assert_eq!(validate_and_prepare(&app, "   "), Err(MediaError::BackupLocationNotAbsolute));
    std::fs::remove_dir_all(&app).ok();
}

#[test]
fn validate_creates_missing_dir_and_write_tests() {
    let app = tmp();
    let base = tmp(); // a target OUTSIDE the app dir
    let target = base.join("new").join("nested").join("backups");
    assert!(!target.exists());
    let stored = validate_and_prepare(&app, &target.to_string_lossy()).unwrap();
    assert!(target.exists(), "missing dir is created");
    assert_eq!(stored, target.to_string_lossy());
    // probe removed — dir is clean
    assert!(!target.join(".lataif_backup_write_test").exists());
    std::fs::remove_dir_all(&app).ok();
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn validate_rejects_unwritable_missing_drive() {
    let app = tmp();
    // A path on a drive that does not exist cannot be created → NotWritable (never a silent fallback).
    #[cfg(windows)]
    let bogus = r"Z:\lataif\definitely\not\present\backups";
    #[cfg(not(windows))]
    let bogus = "/proc/nonexistent-root/lataif/backups"; // create_dir_all fails
    assert_eq!(validate_and_prepare(&app, bogus), Err(MediaError::BackupLocationNotWritable));
    std::fs::remove_dir_all(&app).ok();
}

// ── overlap guard — the target may not equal, sit inside, or contain the live app-data tree ──
#[test]
fn validate_rejects_overlap_with_app_data_tree() {
    let app = tmp();
    // simulate the live tree
    std::fs::create_dir_all(app.join("media")).unwrap();
    std::fs::create_dir_all(app.join("mobile-upload-staging")).unwrap();
    std::fs::create_dir_all(app.join("backups")).unwrap();
    let over = |t: std::path::PathBuf| {
        assert_eq!(
            validate_and_prepare(&app, &t.to_string_lossy()),
            Err(MediaError::BackupLocationOverlapsAppData),
            "must reject overlap: {}", t.display()
        );
    };
    over(app.clone());                              // == app data dir (would snapshot live DBs in place)
    over(app.join("media"));                        // inside: media root
    over(app.join("mobile-upload-staging"));        // inside: staging
    over(app.join("backups"));                      // inside: default backups (recursive nesting)
    over(app.join("sub").join("deep"));             // inside: any descendant
    over(app.parent().unwrap().to_path_buf());      // PARENT of the app dir (backup would contain live data)

    // a sibling directory (not overlapping) is accepted
    let sibling = app.parent().unwrap().join(format!("bkloc-sibling-{}", std::process::id()));
    let ok = validate_and_prepare(&app, &sibling.to_string_lossy());
    assert!(ok.is_ok(), "a non-overlapping sibling is accepted: {ok:?}");
    std::fs::remove_dir_all(&app).ok();
    std::fs::remove_dir_all(&sibling).ok();
}
