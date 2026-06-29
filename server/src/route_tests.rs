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

/// Seed a legacy credit + expense snapshot (t1/b1) so a B1 submit can cut over.
async fn seed_b1_base(state: &AppState) {
    let db = state.db.lock().await;
    for (table, rid, data) in [
        (
            "supplier_credits",
            "cred-1",
            json!({"id":"cred-1","branch_id":"b1","supplier_id":"sup-1","amount":100.0,"used_amount":0.0,"status":"OPEN"}),
        ),
        (
            "expenses",
            "exp-1",
            json!({"id":"exp-1","branch_id":"b1","supplier_id":"sup-1","amount":100.0,"paid_amount":0.0,"status":"PENDING"}),
        ),
    ] {
        db.execute(
            "INSERT INTO sync_changelog (tenant_id, branch_id, table_name, record_id, action, data, user_id, created_at)
             VALUES ('t1','b1',?1,?2,'insert',?3,'u1','t')",
            rusqlite::params![table, rid, data.to_string()],
        )
        .unwrap();
    }
}

/// A valid B1 settlement payload (one credit, one allocation; wire-string fils).
fn b1_payload(
    op_id: &str,
    branch: &str,
    expected_credit_rev: &str,
    amount_fils: &str,
    expected_expense_rev: &str,
) -> Value {
    json!({
        "protocolVersion": 4,
        "operationType": "APPLY_SUPPLIER_CREDIT_TO_EXPENSES",
        "operationId": op_id,
        "businessTimestamp": "2026-01-15T10:30:00.000Z",
        "branchId": branch,
        "creditId": "cred-1",
        "expectedCreditRevision": expected_credit_rev,
        "allocations": [{ "expenseId": "exp-1", "amountFils": amount_fils, "expectedExpenseRevision": expected_expense_rev }],
    })
}

#[tokio::test]
async fn b1_submit_status_and_route_disambiguation() {
    let state = seed_state();
    seed_b1_base(&state).await;
    let router = app(state.clone());
    let op = "bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb";

    // both new routes require a token
    let (s, _) = send(
        &router,
        "POST",
        "/api/operations",
        None,
        Some(b1_payload(op, "b1", "0", "60000", "0")),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _) = send(
        &router,
        "GET",
        &format!("/api/operations/{}", op),
        None,
        None,
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    // submit → 200 accepted
    let (s, body) = send(
        &router,
        "POST",
        "/api/operations",
        Some(&token("t1", "b1")),
        Some(b1_payload(op, "b1", "0", "60000", "0")),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["status"], json!("accepted"));
    let seq = body["serverSequence"].as_str().unwrap().to_string();

    // status of a known operation (tenant-isolated) → accepted, with envelope
    let (s, body) = send(
        &router,
        "GET",
        &format!("/api/operations/{}", op),
        Some(&token("t1", "b1")),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["status"], json!("accepted"));
    assert!(body["envelope"]["mutations"].is_array());
    // other tenant cannot see it
    let (_, body_t2) = send(
        &router,
        "GET",
        &format!("/api/operations/{}", op),
        Some(&token("t2", "b3")),
        None,
    )
    .await;
    assert_eq!(body_t2["status"], json!("unknown"));

    // ROUTE DISAMBIGUATION: `/operations/pull` reaches the pull handler, NOT the
    // status handler with operationId="pull".
    let (s, body) = send(
        &router,
        "GET",
        "/api/operations/pull?since=0",
        Some(&token("t1", "b1")),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert!(
        body.get("cursor").is_some(),
        "pull must hit the pull handler"
    );
    assert!(body.get("operations").is_some());
    assert_ne!(body["operationId"], json!("pull")); // never mis-routed to status
                                                    // the B1 envelope is delivered by the pull
    let delivered = body["operations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|o| o["serverSequence"] == json!(seq));
    assert!(delivered, "pull must deliver the accepted B1 envelope");

    // replay (same id+payload) → 200 REPLAY_STORED
    let (s, body) = send(
        &router,
        "POST",
        "/api/operations",
        Some(&token("t1", "b1")),
        Some(b1_payload(op, "b1", "0", "60000", "0")),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["retryAction"], json!("REPLAY_STORED"));
}

#[tokio::test]
async fn b1_submit_conflict_validation_and_transient_codes() {
    let state = seed_state();
    seed_b1_base(&state).await;
    let router = app(state.clone());

    // stale credit revision → 200 conflict
    let (s, body) = send(
        &router,
        "POST",
        "/api/operations",
        Some(&token("t1", "b1")),
        Some(b1_payload(
            "cccccccc-cccc-5ccc-8ccc-cccccccccccc",
            "b1",
            "9",
            "10000",
            "0",
        )),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["status"], json!("conflict"));
    assert_eq!(body["errorCode"], json!("STALE_REVISION"));

    // amount 0 → 200 validation_rejected (in-tx, stored)
    let (s, body) = send(
        &router,
        "POST",
        "/api/operations",
        Some(&token("t1", "b1")),
        Some(b1_payload(
            "dddddddd-dddd-5ddd-8ddd-dddddddddddd",
            "b1",
            "0",
            "0",
            "0",
        )),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["status"], json!("validation_rejected"));

    // transient (unknown credit → not bootstrapped) → 503, retryable
    let mut p = b1_payload(
        "eeeeeeee-eeee-5eee-8eee-eeeeeeeeeeee",
        "b1",
        "0",
        "10000",
        "0",
    );
    p["creditId"] = json!("cred-unknown");
    let (s, body) = send(
        &router,
        "POST",
        "/api/operations",
        Some(&token("t1", "b1")),
        Some(p),
    )
    .await;
    assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["errorCode"], json!("FINANCE_NOT_BOOTSTRAPPED"));

    // no internal SQL ever leaks
    let text = body.to_string();
    assert!(!text.to_lowercase().contains("sql"));
}

#[tokio::test]
async fn b1_http_auth_and_isolation_matrix() {
    let state = seed_state();
    seed_b1_base(&state).await;
    let router = app(state.clone());

    // payload branchId contradicts the JWT branch → stable validation rejection
    let (s, body) = send(
        &router,
        "POST",
        "/api/operations",
        Some(&token("t1", "b1")),
        Some(b1_payload(
            "a1111111-1111-5111-8111-111111111111",
            "b2",
            "0",
            "10000",
            "0",
        )),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["status"], json!("validation_rejected"));
    assert_eq!(body["errorCode"], json!("BRANCH_MISMATCH"));

    // wrong tenant cannot materialise the foreign credit (cred-1 lives in t1/b1)
    let (s, body) = send(
        &router,
        "POST",
        "/api/operations",
        Some(&token("t2", "b3")),
        Some(b1_payload(
            "a2222222-2222-5222-8222-222222222222",
            "b3",
            "0",
            "10000",
            "0",
        )),
    )
    .await;
    assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["errorCode"], json!("FINANCE_NOT_BOOTSTRAPPED"));

    // wrong branch (same tenant) cannot materialise it either
    let (s, body) = send(
        &router,
        "POST",
        "/api/operations",
        Some(&token("t1", "b2")),
        Some(b1_payload(
            "a3333333-3333-5333-8333-333333333333",
            "b2",
            "0",
            "10000",
            "0",
        )),
    )
    .await;
    assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["errorCode"], json!("FINANCE_NOT_BOOTSTRAPPED"));

    // accept a real op in t1/b1
    let op = "ffffffff-ffff-5fff-8fff-ffffffffffff";
    let (s, body) = send(
        &router,
        "POST",
        "/api/operations",
        Some(&token("t1", "b1")),
        Some(b1_payload(op, "b1", "0", "60000", "0")),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["status"], json!("accepted"));
    let seq = body["serverSequence"].as_str().unwrap().to_string();

    // same operationId, different hash → OPERATION_ID_REUSED, no overwrite
    let (s, body) = send(
        &router,
        "POST",
        "/api/operations",
        Some(&token("t1", "b1")),
        Some(b1_payload(op, "b1", "0", "10000", "0")),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["errorCode"], json!("OPERATION_ID_REUSED"));

    // status: wrong branch (same tenant) → not visible
    let (_, body) = send(
        &router,
        "GET",
        &format!("/api/operations/{}", op),
        Some(&token("t1", "b2")),
        None,
    )
    .await;
    assert_eq!(body["status"], json!("unknown"));
    // status: wrong tenant → not visible
    let (_, body) = send(
        &router,
        "GET",
        &format!("/api/operations/{}", op),
        Some(&token("t2", "b3")),
        None,
    )
    .await;
    assert_eq!(body["status"], json!("unknown"));

    // pull: wrong tenant / wrong branch see no B1 envelope
    let (_, body) = send(
        &router,
        "GET",
        "/api/operations/pull?since=0",
        Some(&token("t2", "b3")),
        None,
    )
    .await;
    assert_eq!(body["operations"].as_array().unwrap().len(), 0);
    let (_, body) = send(
        &router,
        "GET",
        "/api/operations/pull?since=0",
        Some(&token("t1", "b2")),
        None,
    )
    .await;
    assert_eq!(body["operations"].as_array().unwrap().len(), 0);

    // pull: re-pull from the delivered cursor returns no duplicate of the B1 op
    let (_, body) = send(
        &router,
        "GET",
        &format!("/api/operations/pull?since={}", seq),
        Some(&token("t1", "b1")),
        None,
    )
    .await;
    let dup = body["operations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|o| o["serverSequence"] == json!(seq));
    assert!(!dup, "cursor re-pull must not re-deliver the B1 envelope");
}

#[tokio::test]
async fn b1_submit_internal_error_is_stable_code_no_sql() {
    let state = seed_state();
    seed_b1_base(&state).await;
    // force an internal failure at the first authoritative write
    {
        let db = state.db.lock().await;
        db.execute_batch(
            "CREATE TRIGGER inj_ops BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT,'x'); END;",
        )
        .unwrap();
    }
    let router = app(state.clone());
    let (s, body) = send(
        &router,
        "POST",
        "/api/operations",
        Some(&token("t1", "b1")),
        Some(b1_payload(
            "a4444444-4444-5444-8444-444444444444",
            "b1",
            "0",
            "60000",
            "0",
        )),
    )
    .await;
    // a transient internal fault → 503 + a stable public code, never raw SQL
    assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["errorCode"], json!("INTERNAL_ERROR_BEFORE_COMMIT"));
    let text = body.to_string();
    assert!(!text.to_lowercase().contains("sql"));
    assert!(!text.contains("RAISE") && !text.contains("INSERT"));
}
