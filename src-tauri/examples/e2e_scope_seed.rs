// MOBILE-04B2A5-H1 — deterministic, test-only seed/verify tool for the isolated E2E runtime-scope
// smoke. NOT part of the app: an `examples/` binary, run only by the e2e harness against an isolated
// throwaway server DB. `seed` creates+migrates+seeds the server DB (via the SAME init path the app
// uses), provisions the owner, and adds a non-default tenant with two UUID branches (A/B) so the
// dialog can bind + rebind. `verify` reports the binding/audit/inactivity facts. The owner secret is
// passed via the E2E_OWNER_PW env var and is never printed.

use rusqlite::Connection;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(|s| s.as_str()).unwrap_or("");
    let db_path = std::path::PathBuf::from(args.get(2).expect("usage: e2e_scope_seed <seed|verify> <db_path>"));

    match mode {
        "seed" => {
            // Same base schema + migrations + tenant-1/branch-main/user-owner seed the app performs.
            let conn = lataif_lib::e2e_support::init_database(&db_path).expect("init_database");
            let pw = std::env::var("E2E_OWNER_PW").expect("E2E_OWNER_PW must be set (never logged)");
            lataif_lib::e2e_support::provision_owner(
                &conn, &pw, &pw, lataif_lib::e2e_support::PROVISION_CONFIRMATION,
            )
            .expect("provision_owner");
            conn.execute("INSERT OR IGNORE INTO tenants (id,name,slug,plan,active,created_at,updated_at) VALUES ('tenant-acme','Acme Trading','acme','enterprise',1,'now','now')", []).unwrap();
            conn.execute("INSERT OR IGNORE INTO branches (id,tenant_id,name,country,currency,active,created_at,updated_at) VALUES ('aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa','tenant-acme','Acme Branch A','BH','BHD',1,'now','now')", []).unwrap();
            conn.execute("INSERT OR IGNORE INTO branches (id,tenant_id,name,country,currency,active,created_at,updated_at) VALUES ('bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb','tenant-acme','Acme Branch B','BH','BHD',1,'now','now')", []).unwrap();
            println!("SEED_OK");
        }
        // MOBILE-04B2A8-I3 — like `seed`, but ALSO make this install a real Primary so its embedded HTTP
        // server actually serves (`should_serve` = Primary|ReadOnly). Uses the REAL owner-authorized
        // transition: provision the owner, authorize it, then `configure_as_owner(Primary)` bound to this
        // install's id. Deterministic + isolated; the production adoption contract is unchanged.
        "seed-primary" => {
            let conn = lataif_lib::e2e_support::init_database(&db_path).expect("init_database");
            let pw = std::env::var("E2E_OWNER_PW").expect("E2E_OWNER_PW must be set (never logged)");
            lataif_lib::e2e_support::provision_owner(&conn, &pw, &pw, lataif_lib::e2e_support::PROVISION_CONFIRMATION).expect("provision_owner");
            conn.execute("INSERT OR IGNORE INTO tenants (id,name,slug,plan,active,created_at,updated_at) VALUES ('tenant-acme','Acme Trading','acme','enterprise',1,'now','now')", []).unwrap();
            conn.execute("INSERT OR IGNORE INTO branches (id,tenant_id,name,country,currency,active,created_at,updated_at) VALUES ('aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa','tenant-acme','Acme Branch A','BH','BHD',1,'now','now')", []).unwrap();
            conn.execute("INSERT OR IGNORE INTO branches (id,tenant_id,name,country,currency,active,created_at,updated_at) VALUES ('bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb','tenant-acme','Acme Branch B','BH','BHD',1,'now','now')", []).unwrap();
            let install_id = lataif_lib::e2e_support::load_install_id(&db_path).expect("install id");
            let owner = lataif_lib::e2e_support::authorize_owner(&conn, "tenant-1", "branch-main", "admin@lataif.com", &pw).expect("authorize_owner");
            lataif_lib::e2e_support::configure_as_owner(&conn, "tenant-1", "branch-main", lataif_lib::e2e_support::Mode::Primary, &install_id, &owner).expect("configure_as_owner(Primary)");
            println!("SEED_PRIMARY_OK");
        }
        "verify" => {
            let conn = Connection::open(&db_path).expect("open db");
            let active: Option<(String, String, i64)> = conn
                .query_row("SELECT tenant_id, branch_id, binding_revision FROM mobile_runtime_scope WHERE status='active'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .ok();
            let audit: i64 = conn.query_row("SELECT COUNT(*) FROM mobile_runtime_scope_audit", [], |r| r.get(0)).unwrap_or(-1);
            let superseded: i64 = conn.query_row("SELECT COUNT(*) FROM mobile_runtime_scope WHERE status='superseded'", [], |r| r.get(0)).unwrap_or(-1);
            let inbox: i64 = conn.query_row("SELECT COUNT(*) FROM mobile_upload_inbox", [], |r| r.get(0)).unwrap_or(-1);
            // any bcrypt-hash-shaped value anywhere in the audit sink → a secret leak.
            let leak: i64 = conn.query_row("SELECT COUNT(*) FROM mobile_runtime_scope_audit WHERE verified_owner_id LIKE '%$2%' OR result LIKE '%$2%'", [], |r| r.get(0)).unwrap_or(-1);
            let (t, b, rev) = active.unwrap_or_default();
            // MOBILE-04B2A8-I3 — the newest inbox job's state (accepted→processing→ready/quarantine) and
            // the resolved primary mode, so the live harness can assert ingress + worker progress.
            let inbox_state: String = conn.query_row("SELECT state FROM mobile_upload_inbox ORDER BY created_at DESC, upload_event_id DESC LIMIT 1", [], |r| r.get(0)).unwrap_or_else(|_| "none".into());
            let primary_mode: String = conn.query_row("SELECT mode FROM primary_host_config LIMIT 1", [], |r| r.get(0)).unwrap_or_else(|_| "unconfigured".into());
            println!("VERIFY active_tenant={t} active_branch={b} active_rev={rev} audit_events={audit} superseded={superseded} inbox_rows={inbox} inbox_state={inbox_state} primary_mode={primary_mode} secret_leaks={leak}");
        }
        // MOBILE-04B2A8-I3 — emit a valid deterministic JPEG (base64) for the live HTTP upload. `arg2`
        // is a salt so the harness can produce a DIFFERENT valid image for the same-event-id conflict case.
        "jpeg" => {
            use base64::Engine;
            let salt: u8 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);
            let img = image::RgbImage::from_fn(160, 120, |x, y| {
                image::Rgb([(x as u8).wrapping_add(salt), (y as u8) ^ salt, ((x + y) as u8).wrapping_mul(31)])
            });
            let mut buf = Vec::new();
            image::DynamicImage::ImageRgb8(img)
                .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Jpeg)
                .unwrap();
            println!("{}", base64::engine::general_purpose::STANDARD.encode(&buf));
        }
        // MEDIA-04B2A12-I2 — drive the REAL backup snapshot host against a real isolated app_data_dir.
        // `backup <appDataDir> <outDir> <createdAt>` — reads lataif.db + media root + (optional) server DB,
        // selects the required media from the SAME consistent DB, and publishes a consistent snapshot.
        "backup" => {
            let base = &db_path; // args[2] = appDataDir
            let out_dir = std::path::PathBuf::from(
                args.get(3).expect("usage: backup <appDataDir> <outDir> <createdAt>"),
            );
            let created_at = args.get(4).cloned().unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string());
            let front = base.join("lataif.db");
            let media_root = base.join("media");
            let server = base.join("lataif_sync_server.db");
            let conn = Connection::open(&front).expect("open frontend db");
            let selection =
                lataif_lib::e2e_support::collect_selection_from_db(&conn).expect("collect selection");
            drop(conn);
            let server_opt = if server.exists() { Some(server.as_path()) } else { None };
            let input = lataif_lib::e2e_support::SnapshotInput {
                media_root: &media_root,
                frontend_db: &front,
                server_db: server_opt,
                selection: &selection,
                created_at,
                app_version: "e2e".into(),
                schema_version: "s1".into(),
                media_schema_version: "m1".into(),
                out_dir: &out_dir,
                workspace_parent: out_dir.parent().unwrap_or(base),
            };
            match lataif_lib::e2e_support::create_backup_snapshot(&input) {
                Ok(m) => println!(
                    "BACKUP_OK files={} additional={} status={}",
                    m.file_count,
                    m.additional_db_files.len(),
                    m.status
                ),
                Err(e) => {
                    println!("BACKUP_ERR {}", e.code());
                    std::process::exit(3);
                }
            }
        }
        _ => {
            eprintln!("usage: e2e_scope_seed <seed|seed-primary|verify|jpeg|backup> <db_path|salt|appDataDir>");
            std::process::exit(2);
        }
    }
}
