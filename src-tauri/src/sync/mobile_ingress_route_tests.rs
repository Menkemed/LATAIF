// MOBILE-04B2A8-I1 — targeted tests for the authenticated mobile upload ingress route. The exactly-once
// SEMANTICS live in mobile_upload_tests.rs (accept_upload); here we prove the ROUTE: JWT auth, the
// JWT→trusted-scope mapping (never the body), DTO/base64 handling, HTTP status mapping, that one valid
// upload produces exactly one claimable job (accepted inbox row + staged file, no base64), and that
// /sync/push is untouched. Driven over the REAL /api router with tower::oneshot.
use crate::sync::{auth, primary, routes, AppState};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use base64::Engine;
use lataif_server::migrations::run_migrations;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
use tower::util::ServiceExt;

const SECRET: &str = "ingress-test-secret";
const MAX: usize = routes::MAX_SYNC_PUSH_BODY_BYTES;
const CT: Option<&str> = Some("application/json");
const META: &str = r#"{"brand":"Rolex","categoryId":"cat-watch","name":"Sub"}"#;

struct Stg(PathBuf);
impl Stg {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("lataif_ingress_{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&p).unwrap();
        Stg(p)
    }
}
impl Drop for Stg {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

fn seed_sql() -> &'static str {
    "PRAGMA foreign_keys=ON;
     CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, branch_id TEXT NOT NULL, table_name TEXT NOT NULL, record_id TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL, user_id TEXT, created_at TEXT NOT NULL);
     INSERT INTO tenants VALUES ('tenant-1','T','t','now','now');
     INSERT INTO branches VALUES ('branch-main','tenant-1','B','now','now');"
}

fn state_with(primary: primary::State, stg: &Stg) -> Arc<AppState> {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(seed_sql()).unwrap();
    run_migrations(&conn, crate::sync::migrations::EMBEDDED_MIGRATIONS).unwrap();
    Arc::new(AppState {
        db: Mutex::new(conn),
        jwt_secret: SECRET.to_string(),
        frontend_db_path: PathBuf::from("ingress-test-frontend.db"),
        // The staging root IS this fixture's data root, so the ingress writes where the test looks.
        data_root: crate::data_root::DataRoot::for_test(stg.0.clone()),
        primary_state: primary,
        mobile_staging_root: stg.0.clone(),
    })
}
fn state(stg: &Stg) -> Arc<AppState> { state_with(primary::State::Primary, stg) }

fn router(state: Arc<AppState>) -> axum::Router {
    axum::Router::new()
        .nest("/api", routes::build_api_router(state.clone(), MAX))
        .with_state(state)
}
fn token(tenant: &str, branch: &str, role: &str) -> String {
    auth::create_token("user-clerk", tenant, branch, role, SECRET).unwrap()
}
fn jpeg_b64() -> String {
    let img = image::RgbImage::from_fn(120, 90, |x, y| image::Rgb([x as u8, y as u8, (x ^ y) as u8]));
    let mut buf = Vec::new();
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Jpeg)
        .unwrap();
    base64::engine::general_purpose::STANDARD.encode(&buf)
}
fn body_with(event: &str, imgs_b64: Vec<String>, protocol: i64, mode: &str, metadata: &str) -> String {
    let imgs: Vec<String> = imgs_b64
        .into_iter()
        .map(|d| format!(r#"{{"mime":"image/jpeg","data_base64":"{d}"}}"#))
        .collect();
    format!(
        r#"{{"protocol_version":{protocol},"upload_event_id":"{event}","entity_id":"prod-1","mode":"{mode}","metadata":{metadata},"images":[{}]}}"#,
        imgs.join(",")
    )
}
fn upload_req(token: Option<&str>, ctype: Option<&str>, body: String) -> Request<Body> {
    let mut b = Request::builder().method("POST").uri("/api/mobile/upload");
    if let Some(t) = token {
        b = b.header("authorization", format!("Bearer {t}"));
    }
    if let Some(c) = ctype {
        b = b.header("content-type", c);
    }
    b.body(Body::from(body)).unwrap()
}
async fn send(state: &Arc<AppState>, req: Request<Body>) -> (StatusCode, String) {
    let resp = router(state.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    (status, String::from_utf8_lossy(&bytes).to_string())
}
async fn inbox_count(state: &Arc<AppState>) -> i64 {
    state.db.lock().await.query_row("SELECT COUNT(*) FROM mobile_upload_inbox", [], |r| r.get(0)).unwrap()
}
async fn inbox_scope(state: &Arc<AppState>) -> (String, String, String) {
    state.db.lock().await.query_row(
        "SELECT tenant_id, branch_id, state FROM mobile_upload_inbox",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).unwrap()
}
fn staged_files(root: &Path) -> usize {
    fn walk(p: &Path, n: &mut usize) {
        if let Ok(rd) = std::fs::read_dir(p) {
            for e in rd.flatten() {
                let path = e.path();
                if path.is_dir() {
                    walk(&path, n);
                } else if !path.file_name().unwrap().to_string_lossy().ends_with(".tmp") {
                    *n += 1;
                }
            }
        }
    }
    let mut n = 0;
    walk(root, &mut n);
    n
}

// A valid authenticated upload → 201 and EXACTLY one claimable job (accepted inbox row + staged file,
// no base64), scoped from the JWT.
#[tokio::test]
async fn valid_upload_creates_one_claimable_job() {
    let stg = Stg::new();
    let st = state(&stg);
    let (code, body) = send(&st, upload_req(Some(&token("tenant-1", "branch-main", "clerk")), CT, body_with("ev-1", vec![jpeg_b64()], 1, "collection", META))).await;
    assert_eq!(code, StatusCode::CREATED, "body={body}");
    assert!(body.contains("\"state\":\"accepted\"") && body.contains("payloadHash"));
    assert_eq!(inbox_count(&st).await, 1);
    assert_eq!(inbox_scope(&st).await, ("tenant-1".into(), "branch-main".into(), "accepted".into()));
    assert_eq!(staged_files(&stg.0), 1, "exactly one staged file → a verifiable claimable job");
}

// Trust boundary (MOBILE-FIELDS hardening): scope/control-plane keys in metadata are BLOCKED outright — the
// body can never carry tenant/branch. A clean upload is scoped from the JWT only.
#[tokio::test]
async fn scope_comes_from_jwt_not_body() {
    let stg = Stg::new();
    let st = state(&stg);
    let meta_evil = r#"{"tenant_id":"EVIL","branch_id":"EVIL","brand":"X","categoryId":"cat-watch"}"#;
    let (code, b) = send(&st, upload_req(Some(&token("tenant-1", "branch-main", "clerk")), CT, body_with("ev-e", vec![jpeg_b64()], 1, "collection", meta_evil))).await;
    assert_eq!(code, StatusCode::UNPROCESSABLE_ENTITY, "scope keys in the body are rejected, never silently accepted");
    assert!(b.contains("\"code\":\"UNKNOWN_FIELD\""), "the offending control-plane field is named: {b}");
    // and a clean, valid upload IS scoped from the JWT.
    let (code2, _) = send(&st, upload_req(Some(&token("tenant-1", "branch-main", "clerk")), CT, body_with("ev-e2", vec![jpeg_b64()], 1, "collection", META))).await;
    assert_eq!(code2, StatusCode::CREATED);
    assert_eq!(inbox_scope(&st).await.0, "tenant-1", "scope from JWT, never from metadata");
}

// Duplicate (same event + same content) → replay of the SAME job (idempotent), still one inbox row.
#[tokio::test]
async fn duplicate_same_content_replays() {
    let stg = Stg::new();
    let st = state(&stg);
    let img = jpeg_b64();
    let (c1, _) = send(&st, upload_req(Some(&token("tenant-1", "branch-main", "clerk")), CT, body_with("ev-d", vec![img.clone()], 1, "collection", META))).await;
    assert_eq!(c1, StatusCode::CREATED);
    let (c2, b2) = send(&st, upload_req(Some(&token("tenant-1", "branch-main", "clerk")), CT, body_with("ev-d", vec![img], 1, "collection", META))).await;
    assert_eq!(c2, StatusCode::OK, "replay is a 200");
    assert!(b2.contains("\"state\":\"replay\""));
    assert_eq!(inbox_count(&st).await, 1, "no second job on retry");
}

// Same event + DIFFERENT content → 409 conflict, no mutation.
#[tokio::test]
async fn same_event_different_content_conflicts() {
    let stg = Stg::new();
    let st = state(&stg);
    let (c1, _) = send(&st, upload_req(Some(&token("tenant-1", "branch-main", "clerk")), CT, body_with("ev-c", vec![jpeg_b64()], 1, "collection", META))).await;
    assert_eq!(c1, StatusCode::CREATED);
    let (c2, b2) = send(&st, upload_req(Some(&token("tenant-1", "branch-main", "clerk")), CT, body_with("ev-c", vec![jpeg_b64()], 1, "collection", r#"{"brand":"Other","categoryId":"cat-watch","name":"Sub"}"#))).await;
    assert_eq!(c2, StatusCode::CONFLICT);
    assert!(b2.contains("conflict"));
    assert_eq!(inbox_count(&st).await, 1, "conflict is a no-op");
}

// Fail-closed auth: no token → 401 (auth middleware), nothing staged.
#[tokio::test]
async fn no_token_is_unauthorized() {
    let stg = Stg::new();
    let st = state(&stg);
    let (code, _b) = send(&st, upload_req(None, CT, body_with("ev-x", vec![jpeg_b64()], 1, "collection", META))).await;
    assert_eq!(code, StatusCode::UNAUTHORIZED);
    assert_eq!(inbox_count(&st).await, 0);
    assert_eq!(staged_files(&stg.0), 0);
}

// A read-only (non-primary) server refuses every upload with a uniform 403.
#[tokio::test]
async fn read_only_server_forbids_upload() {
    let stg = Stg::new();
    let st = state_with(primary::State::ReadOnly, &stg);
    let (code, _b) = send(&st, upload_req(Some(&token("tenant-1", "branch-main", "clerk")), CT, body_with("ev-r", vec![jpeg_b64()], 1, "collection", META))).await;
    assert_eq!(code, StatusCode::FORBIDDEN);
    assert_eq!(inbox_count(&st).await, 0);
}

// Validation: bad protocol / bad mode → 422 with the stable reject code; nothing staged.
#[tokio::test]
async fn bad_protocol_and_mode_rejected() {
    let stg = Stg::new();
    let st = state(&stg);
    let (c1, b1) = send(&st, upload_req(Some(&token("tenant-1", "branch-main", "clerk")), CT, body_with("ev-p", vec![jpeg_b64()], 999, "collection", META))).await;
    assert_eq!(c1, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(b1.contains("PROTOCOL"));
    let (c2, b2) = send(&st, upload_req(Some(&token("tenant-1", "branch-main", "clerk")), CT, body_with("ev-mode", vec![jpeg_b64()], 1, "repair", META))).await;
    assert_eq!(c2, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(b2.contains("MODE"));
    assert_eq!(inbox_count(&st).await, 0);
}

// Malformed inputs: non-object metadata → 400, bad base64 → 400, too many images → 422, non-JSON → 415.
#[tokio::test]
async fn malformed_inputs_rejected() {
    let stg = Stg::new();
    let st = state(&stg);
    let t = token("tenant-1", "branch-main", "clerk");
    let (cm, _) = send(&st, upload_req(Some(&t), CT, body_with("ev-1", vec![jpeg_b64()], 1, "collection", r#""not-an-object""#))).await;
    assert_eq!(cm, StatusCode::BAD_REQUEST, "metadata must be an object");
    let (cb, _) = send(&st, upload_req(Some(&t), CT, body_with("ev-2", vec!["!!!not-base64!!!".into()], 1, "collection", META))).await;
    assert_eq!(cb, StatusCode::BAD_REQUEST, "bad base64");
    let many: Vec<String> = (0..9).map(|_| jpeg_b64()).collect();
    let (cx, _) = send(&st, upload_req(Some(&t), CT, body_with("ev-3", many, 1, "collection", META))).await;
    assert_eq!(cx, StatusCode::UNPROCESSABLE_ENTITY, "too many images");
    let (cc, _) = send(&st, upload_req(Some(&t), Some("text/plain"), body_with("ev-4", vec![jpeg_b64()], 1, "collection", META))).await;
    assert_eq!(cc, StatusCode::UNSUPPORTED_MEDIA_TYPE, "non-JSON");
    assert_eq!(inbox_count(&st).await, 0);
}

// /sync/push is UNTOUCHED: still auth-gated (401 without a token) and still applies a valid empty push.
#[tokio::test]
async fn sync_push_unchanged() {
    let stg = Stg::new();
    let st = state(&stg);
    let no_tok = Request::builder().method("POST").uri("/api/sync/push").header("content-type", "application/json").body(Body::from(r#"{"changes":[]}"#)).unwrap();
    let (c1, _) = send(&st, no_tok).await;
    assert_eq!(c1, StatusCode::UNAUTHORIZED, "/sync/push still requires auth");
    let ok = Request::builder().method("POST").uri("/api/sync/push").header("authorization", format!("Bearer {}", token("tenant-1", "branch-main", "owner"))).header("content-type", "application/json").body(Body::from(r#"{"changes":[]}"#)).unwrap();
    let (c2, _) = send(&st, ok).await;
    assert_eq!(c2, StatusCode::OK, "/sync/push still applies a valid (empty) push");
}
