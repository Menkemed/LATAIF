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

/// MOBILE-04B2A8-I1 — the authenticated mobile upload ingress DTO. Carries ONLY the client-controllable
/// payload: a stable client-generated `upload_event_id`, the protocol version, the collection mode, the
/// product metadata object, and the raw image bytes (base64). It carries NO tenant/branch/user — those
/// come exclusively from the verified JWT (`Claims`), never from this body. Any `tenant_id`/`branch_id`
/// a client puts inside `metadata` is inert: `accept_upload` scopes by the trusted context only.
#[derive(Deserialize)]
pub struct MobileUploadImageDto {
    /// Declared MIME — advisory only; `accept_upload` re-derives the real format from the decoded bytes
    /// (decode-integrity), so a lying MIME cannot smuggle a foreign format past validation.
    pub mime: String,
    /// Base64 (standard alphabet) of the raw image bytes. No filename, no path — never trusted.
    pub data_base64: String,
}

#[derive(Deserialize)]
pub struct MobileUploadIngressRequest {
    pub protocol_version: i64,
    pub upload_event_id: String,
    #[serde(default)]
    pub entity_id: String,
    pub mode: String,
    /// Product metadata as a JSON object (must be an object; re-serialized canonically server-side).
    pub metadata: serde_json::Value,
    pub images: Vec<MobileUploadImageDto>,
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
