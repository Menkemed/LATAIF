use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct LoginResponse {
    pub token: String,
    pub user_id: String,
    pub tenant_id: String,
    pub branch_id: String,
    pub role: String,
    pub user_name: String,
    pub branch_name: String,
}

#[derive(Deserialize)]
pub struct RegisterTenantRequest {
    pub tenant_name: String,
    pub branch_name: String,
    pub user_name: String,
    pub email: String,
    pub password: String,
    pub country: String,
    pub currency: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SyncChange {
    pub id: i64,
    pub table_name: String,
    pub record_id: String,
    pub branch_id: String,
    pub action: String,
    pub data: String,
    pub created_at: String,
}

#[derive(Deserialize)]
pub struct SyncPushRequest {
    pub changes: Vec<SyncPushChange>,
}

#[derive(Deserialize)]
pub struct SyncPushChange {
    pub table_name: String,
    pub record_id: String,
    pub action: String,
    pub data: String,
}

#[derive(Serialize)]
pub struct SyncPullResponse {
    pub changes: Vec<SyncChange>,
    pub last_sync_id: i64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Claims {
    pub sub: String,
    pub tenant_id: String,
    pub branch_id: String,
    pub role: String,
    pub exp: usize,
}
