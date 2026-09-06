// v0.8.49 — DER AUSLIEFERUNGSVERTRAG des eingebetteten Servers.
//
// Live passiert: nach dem Update auf v0.8.48 zeigte ein Handy weiter die ALTE Mobilseite. Nicht
// weil der Server sie falsch ausgeliefert haette, sondern weil er ueberhaupt nichts darueber sagte,
// ob sie wiederverwendet werden darf — keine Cache-Anweisung, kein Validator. Der Browser hat sie
// dann behalten. Dasselbe galt fuer die JSON-Antworten: derselbe Artikel unter derselben Adresse
// konnte aus dem Cache beantwortet werden, und der Bildschirm zeigte einen Stand, den es nicht
// mehr gab.
//
// Geprueft wird der ECHTE Produktions-Router (`build_app_router`), nicht eine Nachbildung: Seite
// und dynamische Antworten sind `no-store`, und eine Route, die ihre eigene Cache-Angabe macht,
// behaelt sie — das ist die Medien-Route, deren Bytes inhaltsadressiert sind.
use crate::sync::{build_app_router, primary, AppState};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use lataif_server::migrations::run_migrations;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;
use tower::util::ServiceExt;
use tower_http::cors::{Any, CorsLayer};

fn state() -> Arc<AppState> {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, branch_id TEXT NOT NULL, table_name TEXT NOT NULL, record_id TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL, user_id TEXT, created_at TEXT NOT NULL);
         INSERT INTO tenants VALUES ('tenant-1','T','t','now','now');
         INSERT INTO branches VALUES ('branch-main','tenant-1','B','now','now');",
    )
    .unwrap();
    run_migrations(&conn, crate::sync::migrations::EMBEDDED_MIGRATIONS).unwrap();
    let dir = std::env::temp_dir().join(format!("lataif_delivery_{:016x}", rand::random::<u64>()));
    std::fs::create_dir_all(&dir).unwrap();
    Arc::new(AppState {
        db: Mutex::new(conn),
        jwt_secret: "delivery-test-secret".to_string(),
        self_token: None,
        frontend_db_path: PathBuf::from("delivery-test-frontend.db"),
        data_root: crate::data_root::DataRoot::for_test(dir.clone()),
        primary_state: primary::State::Primary,
        server_fingerprint: "testfingerprint00000000000000000".to_string(),
        mobile_staging_root: dir,
    })
}

fn cors() -> CorsLayer {
    CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any)
}

async fn get(uri: &str) -> (StatusCode, Option<String>) {
    let router = build_app_router(state(), cors());
    let resp = router
        .oneshot(Request::builder().method("GET").uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let cc = resp
        .headers()
        .get(axum::http::header::CACHE_CONTROL)
        .map(|v| v.to_str().unwrap_or("").to_string());
    (resp.status(), cc)
}

/// Die Mobilseite selbst: sie aendert sich mit jedem Update, also darf sie nicht liegenbleiben.
#[tokio::test]
async fn the_mobile_page_is_never_stored_by_the_browser() {
    let (status, cc) = get("/mobile").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cc.as_deref(), Some("no-store"), "the page a phone reloads after an update must not be reused");
}

#[tokio::test]
async fn the_landing_page_and_the_wasm_decoder_are_not_stored_either() {
    for uri in ["/", "/zxing-wasm.js", "/zxing_reader.wasm"] {
        let (status, cc) = get(uri).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
        assert_eq!(cc.as_deref(), Some("no-store"), "{uri} ships with the binary and changes with it");
    }
}

/// Die dynamischen Antworten: ein Artikel unter derselben Adresse darf nicht aus dem Cache kommen.
#[tokio::test]
async fn dynamic_api_answers_are_not_stored() {
    let (status, cc) = get("/api/health").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cc.as_deref(), Some("no-store"));
    // Auch die abgewiesene Antwort einer geschuetzten Route traegt die Regel — sonst koennte ein
    // 401 haengenbleiben und eine gueltige Sitzung als abgelaufen erscheinen lassen.
    let (status, cc) = get("/api/products/by-id/whatever").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(cc.as_deref(), Some("no-store"));
}

/// Die EINE Ausnahme: wer seine eigene Cache-Angabe macht, behaelt sie. Genau so bleiben die
/// inhaltsadressierten Medien-Bytes cachebar, waehrend alles andere frisch geholt wird.
#[tokio::test]
async fn a_route_with_its_own_cache_rule_keeps_it() {
    async fn immutable_route() -> impl axum::response::IntoResponse {
        (
            [(axum::http::header::CACHE_CONTROL, "private, max-age=31536000, immutable")],
            "bytes",
        )
    }
    let router = axum::Router::new()
        .route("/immutable", axum::routing::get(immutable_route))
        .route("/plain", axum::routing::get(|| async { "hello" }))
        .layer(axum::middleware::from_fn(crate::sync::routes::no_store_if_absent));

    let r = router
        .clone()
        .oneshot(Request::builder().uri("/immutable").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(
        r.headers().get(axum::http::header::CACHE_CONTROL).unwrap(),
        "private, max-age=31536000, immutable",
        "content-addressed bytes stay cacheable"
    );

    let r = router
        .oneshot(Request::builder().uri("/plain").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(r.headers().get(axum::http::header::CACHE_CONTROL).unwrap(), "no-store");
}

/// …und die Medien-Route macht diese Angabe wirklich. Ohne diesen Waechter koennte sie jemand
/// entfernen, und der obige Vertrag wuerde die Bytes still auf `no-store` setzen.
#[tokio::test]
async fn the_media_route_still_declares_itself_immutable() {
    let src = include_str!("routes.rs");
    assert!(
        src.contains("(axum::http::header::CACHE_CONTROL, \"private, max-age=31536000, immutable\")"),
        "the media route must keep declaring its own cache rule"
    );
}
