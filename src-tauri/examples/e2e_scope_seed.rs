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
            println!("VERIFY active_tenant={t} active_branch={b} active_rev={rev} audit_events={audit} superseded={superseded} inbox_rows={inbox} secret_leaks={leak}");
        }
        _ => {
            eprintln!("usage: e2e_scope_seed <seed|verify> <db_path>");
            std::process::exit(2);
        }
    }
}
