// BACKUP-RETENTION — config read/write/clamp contracts (headless). Prune-over-real-snapshots is covered in
// backup_tests.rs (which can build complete snapshots via execute_pending_backup).
use super::*;
use rusqlite::Connection;

fn tmp() -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    let n = format!(
        "lataif-bkret-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    );
    p.push(n);
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn config_db(app: &std::path::Path) -> Connection {
    let conn = Connection::open(app.join(CONFIG_DB)).unwrap();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS backup_retention_config (
            tenant_id TEXT NOT NULL PRIMARY KEY, enabled INTEGER NOT NULL,
            keep_count INTEGER NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT);",
    )
    .unwrap();
    conn
}

#[test]
fn default_is_disabled_with_default_keep() {
    let app = tmp();
    let info = current(&app); // no config DB at all
    assert!(!info.enabled, "retention is OFF until explicitly enabled");
    assert_eq!(info.default_keep, DEFAULT_KEEP);
    assert_eq!(info.keep_count, DEFAULT_KEEP);
    std::fs::remove_dir_all(&app).ok();
}

#[test]
fn set_get_roundtrip_and_toggle() {
    let app = tmp();
    let conn = config_db(&app);
    set_configured(&conn, true, 3, "owner", "t1").unwrap();
    drop(conn);
    let info = current(&app);
    assert!(info.enabled && info.keep_count == 3);

    // disable again → current reflects disabled (keep_count value is retained but inert)
    let conn = config_db(&app);
    set_configured(&conn, false, 3, "owner", "t2").unwrap();
    drop(conn);
    assert!(!current(&app).enabled);
    std::fs::remove_dir_all(&app).ok();
}

#[test]
fn keep_count_is_clamped() {
    assert_eq!(clamp_keep(0), MIN_KEEP);
    assert_eq!(clamp_keep(-5), MIN_KEEP);
    assert_eq!(clamp_keep(5), 5);
    assert_eq!(clamp_keep(10_000), MAX_KEEP);
    // stored value is clamped, not the raw input
    let app = tmp();
    let conn = config_db(&app);
    set_configured(&conn, true, 0, "o", "t").unwrap();
    let got: i64 = conn.query_row("SELECT keep_count FROM backup_retention_config", [], |r| r.get(0)).unwrap();
    assert_eq!(got, MIN_KEEP);
    drop(conn);
    std::fs::remove_dir_all(&app).ok();
}

#[test]
fn set_is_idempotent_one_row() {
    let app = tmp();
    let conn = config_db(&app);
    set_configured(&conn, true, 2, "o", "t1").unwrap();
    set_configured(&conn, true, 7, "o", "t2").unwrap();
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM backup_retention_config", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
    let k: i64 = conn.query_row("SELECT keep_count FROM backup_retention_config", [], |r| r.get(0)).unwrap();
    assert_eq!(k, 7);
    drop(conn);
    std::fs::remove_dir_all(&app).ok();
}

#[test]
fn prune_noop_when_disabled_or_no_config() {
    let app = tmp();
    // no config DB → prune disabled, no crash
    let r = prune(&app);
    assert!(!r.enabled && r.deleted == 0 && r.failed == 0);
    std::fs::remove_dir_all(&app).ok();
}
