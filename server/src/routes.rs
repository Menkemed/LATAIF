use axum::{
    extract::{Extension, Query, State},
    http::StatusCode,
    middleware,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use std::sync::Arc;

use crate::{auth, models::*, AppState};

pub fn api_routes() -> Router<Arc<AppState>> {
    let protected = Router::new()
        .route("/sync/push", post(sync_push))
        .route("/sync/pull", get(sync_pull))
        .route("/operations/pull", get(operations_pull))
        .route("/me", get(get_me))
        .route_layer(middleware::from_fn(auth::auth_middleware));

    Router::new()
        .route("/auth/login", post(login))
        .route("/auth/register", post(register_tenant))
        .route("/health", get(health))
        .merge(protected)
}

async fn health() -> &'static str {
    "LATAIF Server OK"
}

async fn login(
    State(state): State<Arc<AppState>>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, StatusCode> {
    let db = state.db.lock().await;

    let result: Result<(String, String, String, String, String, String, String), _> = db
        .prepare(
            "SELECT u.id, u.tenant_id, u.name, u.password_hash, ub.branch_id, ub.role, b.name
             FROM users u
             JOIN user_branches ub ON ub.user_id = u.id AND ub.is_default = 1
             JOIN branches b ON b.id = ub.branch_id
             WHERE u.email = ?1 AND u.active = 1",
        )
        .and_then(|mut stmt| {
            stmt.query_row(rusqlite::params![req.email], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            })
        });

    let (user_id, tenant_id, user_name, password_hash, branch_id, role, branch_name) =
        result.map_err(|_| StatusCode::UNAUTHORIZED)?;

    if !bcrypt::verify(&req.password, &password_hash).unwrap_or(false) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let token = auth::create_token(&user_id, &tenant_id, &branch_id, &role, &state.jwt_secret)?;

    Ok(Json(LoginResponse {
        token,
        user_id,
        tenant_id,
        branch_id,
        role,
        user_name,
        branch_name,
    }))
}

async fn register_tenant(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegisterTenantRequest>,
) -> Result<Json<LoginResponse>, StatusCode> {
    let db = state.db.lock().await;
    let now = chrono::Utc::now().to_rfc3339();
    let tenant_id = uuid::Uuid::new_v4().to_string();
    let branch_id = uuid::Uuid::new_v4().to_string();
    let user_id = uuid::Uuid::new_v4().to_string();
    let slug = req.tenant_name.to_lowercase().replace(' ', "-");

    let password_hash =
        bcrypt::hash(&req.password, 10).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    db.execute(
        "INSERT INTO tenants (id, name, slug, plan, active, created_at, updated_at) VALUES (?1, ?2, ?3, 'starter', 1, ?4, ?4)",
        rusqlite::params![tenant_id, req.tenant_name, slug, now],
    ).map_err(|_| StatusCode::CONFLICT)?;

    db.execute(
        "INSERT INTO branches (id, tenant_id, name, country, currency, active, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)",
        rusqlite::params![branch_id, tenant_id, req.branch_name, req.country, req.currency, now],
    ).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    db.execute(
        "INSERT INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)",
        rusqlite::params![user_id, tenant_id, req.email, password_hash, req.user_name, now],
    ).map_err(|_| StatusCode::CONFLICT)?;

    db.execute(
        "INSERT INTO user_branches (user_id, branch_id, role, is_default, created_at) VALUES (?1, ?2, 'owner', 1, ?3)",
        rusqlite::params![user_id, branch_id, now],
    ).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let token = auth::create_token(&user_id, &tenant_id, &branch_id, "owner", &state.jwt_secret)?;

    Ok(Json(LoginResponse {
        token,
        user_id,
        tenant_id,
        branch_id,
        role: "owner".to_string(),
        user_name: req.user_name,
        branch_name: req.branch_name,
    }))
}

async fn get_me(Extension(claims): Extension<Claims>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "user_id": claims.sub,
        "tenant_id": claims.tenant_id,
        "branch_id": claims.branch_id,
        "role": claims.role,
    }))
}

async fn sync_push(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<SyncPushRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let db = state.db.lock().await;
    let now = chrono::Utc::now().to_rfc3339();
    // B0: the whole batch is processed in one BEGIN IMMEDIATE transaction through
    // the schema-oriented bridge (folds non-credit settlement on cut-over records,
    // blocks protected mutations, relays the rest). All-or-nothing.
    match crate::authoritative_sync::bridge::process_sync_batch(
        &db,
        &claims.tenant_id,
        &claims.branch_id,
        &claims.sub,
        &req.changes,
        &now,
    ) {
        Ok(n) => (StatusCode::OK, Json(serde_json::json!({ "synced": n }))),
        Err(e) => {
            let code = if matches!(e, crate::authoritative_sync::bridge::BatchError::Internal) {
                StatusCode::INTERNAL_SERVER_ERROR
            } else {
                StatusCode::CONFLICT
            };
            // Only the stable B0 error code is exposed — never a raw SQL message.
            (
                code,
                Json(serde_json::json!({ "error": e.code(), "rejected": true })),
            )
        }
    }
}

#[derive(Deserialize)]
struct OpsPullParams {
    since: Option<i64>,
    limit: Option<i64>,
}

/// B0 — operations pull (no submit). Tenant/branch come only from the claims.
async fn operations_pull(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Query(params): Query<OpsPullParams>,
) -> (StatusCode, Json<serde_json::Value>) {
    let db = state.db.lock().await;
    match crate::authoritative_sync::pull_operations(
        &db,
        &claims.tenant_id,
        &claims.branch_id,
        params.since.unwrap_or(0),
        params.limit.unwrap_or(100),
    ) {
        Ok(result) => (
            StatusCode::OK,
            Json(crate::authoritative_sync::pull_result_json(&result)),
        ),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "B0_INTERNAL" })),
        ),
    }
}

#[derive(Deserialize)]
struct PullParams {
    since: Option<i64>,
}

async fn sync_pull(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Query(params): Query<PullParams>,
) -> Result<Json<SyncPullResponse>, StatusCode> {
    let db = state.db.lock().await;
    let since_id = params.since.unwrap_or(0);

    let mut stmt = db
        .prepare(
            "SELECT id, table_name, record_id, branch_id, action, data, created_at
             FROM sync_changelog
             WHERE tenant_id = ?1 AND id > ?2
             ORDER BY id ASC LIMIT 1000",
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let changes: Vec<SyncChange> = stmt
        .query_map(rusqlite::params![claims.tenant_id, since_id], |row| {
            Ok(SyncChange {
                id: row.get(0)?,
                table_name: row.get(1)?,
                record_id: row.get(2)?,
                branch_id: row.get(3)?,
                action: row.get(4)?,
                data: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .filter_map(|r| r.ok())
        .collect();

    let last_sync_id = changes.last().map(|c| c.id).unwrap_or(since_id);

    Ok(Json(SyncPullResponse {
        changes,
        last_sync_id,
    }))
}
