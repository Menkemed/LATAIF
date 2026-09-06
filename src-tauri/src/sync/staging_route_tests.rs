// CENTRAL-C3C FINAL — die neutrale Ablage über den ECHTEN Routenbaum.
//
// `media_staging_tests` prüft den Kern; hier läuft die Route selbst, mit derselben
// `build_api_router`-Zusammenstellung, die auch die Produktion fährt. Drei Fragen, die man nur so
// beantworten kann:
//
//   1. Liegt sie wirklich HINTER der Anmeldung? (Ohne Token darf kein Byte liegen bleiben.)
//   2. Woher kommt der Eigentümer? (Aus dem geprüften Token — und aus nichts sonst.)
//   3. Kann ein Aufrufer im Rumpf eine fremde Identität behaupten? (Es gibt kein Feld dafür, und
//      ein mitgeschicktes wird nicht gelesen.)

use crate::sync::{auth, media_staging, primary, routes, AppState};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use base64::Engine;
use lataif_server::migrations::run_migrations;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
use tower::util::ServiceExt;

const SECRET: &str = "staging-route-secret";
const MAX: usize = routes::MAX_SYNC_PUSH_BODY_BYTES;

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("lataif_staging_route_{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&p).unwrap();
        Root(p)
    }
    fn staging(&self) -> PathBuf {
        self.0.join(crate::data_root::COMMAND_STAGING_DIRNAME)
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn seed_sql() -> &'static str {
    "PRAGMA foreign_keys=ON;
     CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, branch_id TEXT NOT NULL, table_name TEXT NOT NULL, record_id TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL, user_id TEXT, created_at TEXT NOT NULL);
     INSERT INTO tenants VALUES ('tenant-1','T','t','now','now');
     INSERT INTO branches VALUES ('branch-main','tenant-1','B','now','now');
     CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, tenant_id TEXT, email TEXT, password_hash TEXT, name TEXT, active INTEGER, created_at TEXT, updated_at TEXT);
     CREATE TABLE IF NOT EXISTS user_branches (user_id TEXT, branch_id TEXT, role TEXT, is_default INTEGER, created_at TEXT);
     INSERT OR IGNORE INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at) VALUES ('user-a','tenant-1','a@t','x','A',1,'now','now');
     INSERT OR IGNORE INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at) VALUES ('user-b','tenant-1','b@t','x','B',1,'now','now');
     INSERT OR IGNORE INTO user_branches (user_id, branch_id, role, is_default, created_at) VALUES ('user-a','branch-main','owner',1,'now');
     INSERT OR IGNORE INTO user_branches (user_id, branch_id, role, is_default, created_at) VALUES ('user-b','branch-main','owner',1,'now');"
}

fn state_with(role: primary::State, root: &Root) -> Arc<AppState> {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(seed_sql()).unwrap();
    run_migrations(&conn, crate::sync::migrations::EMBEDDED_MIGRATIONS).unwrap();
    // CENTRAL-C4 — jede geschuetzte Anfrage schlaegt ihren Absender im heutigen Zustand nach.
    // Ein angemeldeter Benutzer hat deshalb auch hier seine Berechtigungszeile; die Tabelle
    // selbst legt die echte Migration an.
    conn.execute_batch(
        "INSERT OR IGNORE INTO server_credentials (user_id, credential_state, password_changed_at, created_at, updated_at) VALUES ('user-a','active','now','now','now');
         INSERT OR IGNORE INTO server_credentials (user_id, credential_state, password_changed_at, created_at, updated_at) VALUES ('user-b','active','now','now','now');",
    )
    .unwrap();
    Arc::new(AppState {
        db: Mutex::new(conn),
        jwt_secret: SECRET.to_string(),
        // Diese Testfundamente stellen kein Selbst-Token aus — der interne Bypass ist hier also
        // schlicht nicht erreichbar, und genau so soll es sein.
        self_token: None,
        frontend_db_path: PathBuf::from("staging-route-frontend.db"),
        data_root: crate::data_root::DataRoot::for_test(root.0.clone()),
        primary_state: role,
        server_fingerprint: "testfingerprint00000000000000000".to_string(),
        mobile_staging_root: root.0.join("mobile-upload-staging"),
    })
}

fn router(state: Arc<AppState>) -> axum::Router {
    axum::Router::new()
        .nest("/api", routes::build_api_router(state.clone(), MAX))
        .with_state(state)
}

fn token(user: &str, tenant: &str, branch: &str, role: &str) -> String {
    auth::create_token(user, tenant, branch, role, SECRET).unwrap()
}

fn jpeg_b64(salt: u8) -> String {
    let img = image::RgbImage::from_fn(60, 40, |x, y| {
        image::Rgb([(x as u8).wrapping_add(salt), y as u8, (x ^ y) as u8])
    });
    let mut buf = Vec::new();
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Jpeg)
        .unwrap();
    base64::engine::general_purpose::STANDARD.encode(&buf)
}

fn post(tok: Option<&str>, body: String) -> Request<Body> {
    let mut b = Request::builder().method("POST").uri("/api/staging/media");
    if let Some(t) = tok {
        b = b.header("authorization", format!("Bearer {t}"));
    }
    b = b.header("content-type", "application/json");
    b.body(Body::from(body)).unwrap()
}

async fn send(state: &Arc<AppState>, req: Request<Body>) -> (StatusCode, String) {
    let resp = router(state.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    (status, String::from_utf8_lossy(&bytes).to_string())
}

/// Wie viele Ablagen es insgesamt gibt — über alle Eigentümerfächer.
fn staged_total(root: &Path) -> usize {
    let mut n = 0;
    if let Ok(owners) = std::fs::read_dir(root) {
        for o in owners.flatten() {
            if let Ok(files) = std::fs::read_dir(o.path()) {
                n += files.flatten().filter(|f| f.path().extension().map(|e| e == "bin").unwrap_or(false)).count();
            }
        }
    }
    n
}

fn body(mime: &str, data: &str) -> String {
    format!(r#"{{"mime":"{mime}","dataBase64":"{data}"}}"#)
}

#[tokio::test]
async fn without_a_token_nothing_is_ever_staged() {
    let root = Root::new();
    let state = state_with(primary::State::Primary, &root);

    // Kein Kopf, ein kaputter, ein fremd signierter: dreimal dasselbe Ergebnis.
    let foreign = auth::create_token("user-a", "tenant-1", "branch-main", "owner", "ein-anderes-geheimnis").unwrap();
    for (what, tok) in [
        ("ohne Kopfzeile", None),
        ("mit Unsinn", Some("nicht-einmal-ein-token")),
        ("fremd signiert", Some(foreign.as_str())),
    ] {
        let (status, _) = send(&state, post(tok, body("image/jpeg", &jpeg_b64(1)))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{what}: die Route liegt hinter der Anmeldung");
        assert_eq!(staged_total(&root.staging()), 0, "{what}: und es liegt kein Byte da");
    }
}

#[tokio::test]
async fn a_valid_token_stages_under_the_owner_from_the_claims() {
    let root = Root::new();
    let state = state_with(primary::State::Primary, &root);
    let tok = token("user-a", "tenant-1", "branch-main", "owner");

    let (status, text) = send(&state, post(Some(&tok), body("image/jpeg", &jpeg_b64(2)))).await;
    assert_eq!(status, StatusCode::CREATED, "ein angemeldeter Aufrufer darf ablegen: {text}");
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    let id = v["stagingId"].as_str().expect("eine Kennung");
    assert!(media_staging::is_staging_id(id), "die Kennung ist ein Inhaltshash");

    // Sie liegt GENAU im Fach der Identität aus dem Token — und nirgends sonst.
    let owner = media_staging::owner_key("tenant-1", "branch-main", "user-a");
    assert!(
        media_staging::read_staged(&root.staging(), &owner, id).is_ok(),
        "der Eigentümer findet seine Ablage"
    );
    assert_eq!(staged_total(&root.staging()), 1, "und es ist genau eine");

    // Ein anderer Benutzer derselben Filiale findet sie nicht — obwohl er die Kennung hat.
    let other = media_staging::owner_key("tenant-1", "branch-main", "user-b");
    assert_eq!(
        media_staging::read_staged(&root.staging(), &other, id),
        Err(media_staging::ERR_NOT_FOUND),
        "die Kennung allein berechtigt zu nichts"
    );
}

#[tokio::test]
async fn the_body_cannot_claim_an_identity() {
    let root = Root::new();
    let state = state_with(primary::State::Primary, &root);
    let tok = token("user-a", "tenant-1", "branch-main", "owner");

    // Der Rumpf BEHAUPTET einen anderen Mandanten, eine andere Filiale, einen anderen Benutzer —
    // und sogar einen Eigentümerschlüssel. Nichts davon wird gelesen.
    let data = jpeg_b64(3);
    let forged = format!(
        r#"{{"mime":"image/jpeg","dataBase64":"{data}","tenantId":"tenant-2","branchId":"branch-x","userId":"user-b","owner":"{}"}}"#,
        media_staging::owner_key("tenant-2", "branch-x", "user-b")
    );
    let (status, text) = send(&state, post(Some(&tok), forged)).await;
    assert_eq!(status, StatusCode::CREATED, "der Zusatz wird ignoriert, nicht gefeiert: {text}");
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    let id = v["stagingId"].as_str().unwrap();

    let real = media_staging::owner_key("tenant-1", "branch-main", "user-a");
    let claimed = media_staging::owner_key("tenant-2", "branch-x", "user-b");
    assert!(media_staging::read_staged(&root.staging(), &real, id).is_ok(), "sie liegt beim ECHTEN Absender");
    assert_eq!(
        media_staging::read_staged(&root.staging(), &claimed, id),
        Err(media_staging::ERR_NOT_FOUND),
        "und nicht bei der behaupteten Identität"
    );
    assert_eq!(staged_total(&root.staging()), 1, "es entstand genau eine Ablage");
}

#[tokio::test]
async fn two_identities_never_share_a_shelf_even_with_identical_bytes() {
    let root = Root::new();
    let state = state_with(primary::State::Primary, &root);
    let data = jpeg_b64(4);

    let a = token("user-a", "tenant-1", "branch-main", "owner");
    let b = token("user-b", "tenant-1", "branch-main", "owner");
    let (sa, ta) = send(&state, post(Some(&a), body("image/jpeg", &data))).await;
    let (sb, tb) = send(&state, post(Some(&b), body("image/jpeg", &data))).await;
    assert_eq!((sa, sb), (StatusCode::CREATED, StatusCode::CREATED));

    let ida = serde_json::from_str::<serde_json::Value>(&ta).unwrap()["stagingId"].as_str().unwrap().to_string();
    let idb = serde_json::from_str::<serde_json::Value>(&tb).unwrap()["stagingId"].as_str().unwrap().to_string();
    // Dieselben Bytes → dieselbe KENNUNG (sie benennt den Inhalt) …
    assert_eq!(ida, idb, "der Hash benennt den Inhalt, nicht den Absender");
    // … aber zwei getrennte Ablagen. Räumt der eine auf, verliert der andere nichts.
    assert_eq!(staged_total(&root.staging()), 2, "jeder hat seine eigene");
    let owner_a = media_staging::owner_key("tenant-1", "branch-main", "user-a");
    let owner_b = media_staging::owner_key("tenant-1", "branch-main", "user-b");
    media_staging::discard_staged(&root.staging(), &owner_a, &ida).unwrap();
    assert_eq!(media_staging::read_staged(&root.staging(), &owner_a, &ida), Err(media_staging::ERR_NOT_FOUND));
    assert!(media_staging::read_staged(&root.staging(), &owner_b, &idb).is_ok(), "der andere behält seine");
}

#[tokio::test]
async fn a_read_only_client_server_stages_nothing() {
    let root = Root::new();
    // Ein Server, der nicht schreiben darf, ist auch kein Briefkasten: derselbe fail-closed Riegel
    // wie am mobilen Eingang.
    let state = state_with(primary::State::Client, &root);
    let tok = token("user-a", "tenant-1", "branch-main", "owner");
    let (status, _) = send(&state, post(Some(&tok), body("image/jpeg", &jpeg_b64(5)))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(staged_total(&root.staging()), 0, "und nichts liegt da");
}

#[tokio::test]
async fn what_is_not_an_image_is_refused_at_the_route() {
    let root = Root::new();
    let state = state_with(primary::State::Primary, &root);
    let tok = token("user-a", "tenant-1", "branch-main", "owner");

    let pdf = base64::engine::general_purpose::STANDARD.encode(b"%PDF-1.7 not an image");
    let (status, text) = send(&state, post(Some(&tok), body("image/jpeg", &pdf))).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{text}");
    assert!(text.contains("rejected"), "mit einem Grund: {text}");
    assert_eq!(staged_total(&root.staging()), 0, "und ohne Ablage");

    // Ein falsch behaupteter Typ ebenso.
    let (status2, _) = send(&state, post(Some(&tok), body("image/png", &jpeg_b64(6)))).await;
    assert_eq!(status2, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(staged_total(&root.staging()), 0);
}
