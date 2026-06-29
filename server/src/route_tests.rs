//! B0 — real Axum-route tests for the auth/HTTP contract of the operations-pull
//! and sync-push routes (tenant/branch isolation, token enforcement, the stable
//! error contract — never raw SQL).

use crate::{auth, routes, AppState};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;
use tower::ServiceExt;

/// Matches the `auth_middleware` default secret (no JWT_SECRET env in tests).
const SECRET: &str = "lataif_secret_2026_change_in_production";
const HASH64: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn seed_state() -> Arc<AppState> {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "PRAGMA foreign_keys=ON;
         CREATE TABLE tenants (id TEXT PRIMARY KEY);
         CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT);
         CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT);
         CREATE TABLE sync_changelog (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT NOT NULL, branch_id TEXT NOT NULL,
            table_name TEXT NOT NULL, record_id TEXT NOT NULL,
            action TEXT NOT NULL, data TEXT NOT NULL,
            user_id TEXT, created_at TEXT NOT NULL);
         INSERT INTO tenants (id) VALUES ('t1'),('t2');
         INSERT INTO branches (id, tenant_id) VALUES ('b1','t1'),('b2','t1'),('b3','t2');
         INSERT INTO users (id, tenant_id) VALUES ('u1','t1'),('u2','t2');",
    )
    .unwrap();
    crate::migrations::run_migrations(&conn, crate::migrations::ALL_MIGRATIONS).unwrap();
    // one accepted operation envelope for t1/b1 (serverSequence = 1)
    conn.execute(
        "INSERT INTO operations
           (tenant_id, operation_id, branch_id, operation_type, protocol_version, actor_id,
            payload_hash, canonical_payload_json, status, result_json, created_at, committed_at)
         VALUES ('t1','op-1','b1','APPLY_SUPPLIER_CREDIT_TO_EXPENSES',4,'u1',?1,'{}','accepted','{}','t','t')",
        rusqlite::params![HASH64],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO operation_sequence (tenant_id, branch_id, operation_id, created_at)
         VALUES ('t1','b1','op-1','t')",
        [],
    )
    .unwrap();
    let seq = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO operation_envelopes
           (tenant_id, branch_id, operation_id, server_sequence, envelope_json, byte_size, mutation_count, created_at)
         VALUES ('t1','b1','op-1',?1,'{\"operationId\":\"op-1\"}',0,0,'t')",
        rusqlite::params![seq],
    )
    .unwrap();
    Arc::new(AppState {
        db: Mutex::new(conn),
        jwt_secret: SECRET.to_string(),
    })
}

fn app(state: Arc<AppState>) -> Router {
    Router::new()
        .nest("/api", routes::api_routes())
        .with_state(state)
}

fn token(tenant: &str, branch: &str) -> String {
    auth::create_token("u1", tenant, branch, "owner", SECRET).unwrap()
}

async fn send(
    router: &Router,
    method: &str,
    uri: &str,
    bearer: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut b = Request::builder().method(method).uri(uri);
    if let Some(t) = bearer {
        b = b.header("Authorization", format!("Bearer {}", t));
    }
    let req = match body {
        Some(v) => b
            .header("content-type", "application/json")
            .body(Body::from(v.to_string()))
            .unwrap(),
        None => b.body(Body::empty()).unwrap(),
    };
    let res = router.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, v)
}

async fn seed_protected_expense(state: &AppState) {
    let db = state.db.lock().await;
    let data = json!({
        "expenseId": "exp-1", "tenantId": "t1", "branchId": "b1", "supplierId": "sup-1",
        "amountFils": 100000, "nonCreditPaidFils": 0, "creditPaidFils": 60000,
        "settledFils": 60000, "openFils": 40000, "status": "PENDING"
    });
    db.execute(
        "INSERT INTO canonical_records (tenant_id,branch_id,table_name,record_id,record_revision,deleted,data_json,last_operation_id,updated_at)
         VALUES ('t1','b1','expenses','exp-1',1,0,?1,'B1','t')",
        rusqlite::params![data.to_string()],
    )
    .unwrap();
}

#[tokio::test]
async fn operations_pull_route_auth_and_isolation() {
    let router = app(seed_state());

    // no token → 401
    let (s, _) = send(&router, "GET", "/api/operations/pull?since=0", None, None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    // valid t1/b1 → 200 + exactly one full envelope, cursor = "1", no SQL text
    let (s, body) = send(
        &router,
        "GET",
        "/api/operations/pull?since=0",
        Some(&token("t1", "b1")),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["operations"].as_array().unwrap().len(), 1);
    assert_eq!(body["operations"][0]["serverSequence"], json!("1"));
    assert_eq!(
        body["operations"][0]["envelope"]["operationId"],
        json!("op-1")
    );
    assert_eq!(body["hasMore"], json!(false));
    let cursor = body["cursor"].as_str().unwrap().to_string();

    // re-pull from the returned cursor → no duplicate
    let (_, body2) = send(
        &router,
        "GET",
        &format!("/api/operations/pull?since={}", cursor),
        Some(&token("t1", "b1")),
        None,
    )
    .await;
    assert_eq!(body2["operations"].as_array().unwrap().len(), 0);

    // wrong branch (same tenant) sees nothing
    let (_, b3) = send(
        &router,
        "GET",
        "/api/operations/pull?since=0",
        Some(&token("t1", "b2")),
        None,
    )
    .await;
    assert_eq!(b3["operations"].as_array().unwrap().len(), 0);

    // wrong tenant sees nothing
    let (_, b4) = send(
        &router,
        "GET",
        "/api/operations/pull?since=0",
        Some(&token("t2", "b3")),
        None,
    )
    .await;
    assert_eq!(b4["operations"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn sync_push_route_relays_and_blocks_with_stable_codes() {
    let state = seed_state();
    let router = app(state.clone());

    // unauthenticated → 401
    let (s, _) = send(
        &router,
        "POST",
        "/api/sync/push",
        None,
        Some(json!({"changes":[]})),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    // normal (unprotected) relay → 200
    let (s, body) = send(&router, "POST", "/api/sync/push", Some(&token("t1", "b1")),
        Some(json!({"changes":[{"table_name":"products","record_id":"p1","action":"update","data":"{}"}]}))).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["synced"], json!(1));

    // protected forbidden change → 409 + stable B0 code, never a raw SQL message
    seed_protected_expense(&state).await;
    let (s, body) = send(&router, "POST", "/api/sync/push", Some(&token("t1", "b1")),
        Some(json!({"changes":[{"table_name":"expenses","record_id":"exp-1","action":"delete","data":"{}"}]}))).await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(body["error"], json!("B0_PROTECTED_EXPENSE_CANCEL_DELETE"));
    assert!(body.get("rejected").is_some());
    // the body carries only the stable code — no SQL fragments
    let text = body.to_string();
    assert!(!text.to_lowercase().contains("sql"));
    assert!(!text.contains("INSERT"));
}
