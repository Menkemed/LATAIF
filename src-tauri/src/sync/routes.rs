use axum::{
    extract::{DefaultBodyLimit, Extension, Path, Query, State},
    http::{HeaderMap, StatusCode},
    middleware,
    routing::{get, post},
    Json, Router,
};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use std::sync::Arc;

use super::{auth, models::*, AppState};

/// M6-B3A3 §3 — the production limit on a raw `/sync/push` body. 50 MB covers the largest legit
/// batch (pushChanges LIMITs 100 changes; a mobile photo at 1600px @ 0.85 is ~0.5 MB base64). It is
/// the value production always uses; only the test router substitutes a small limit to prove the
/// exact boundary without a 50 MB allocation.
pub const MAX_SYNC_PUSH_BODY_BYTES: usize = 50 * 1024 * 1024;

pub fn api_routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    let protected = Router::new()
        .route("/sync/push", post(sync_push))
        .route("/sync/pull", get(sync_pull))
        .route("/me", get(get_me))
        .route("/products/by-sku/{sku}", get(product_by_sku))
        .route_layer(middleware::from_fn_with_state(state, auth::auth_middleware));

    Router::new()
        .route("/auth/login", post(login))
        // M6-B2A1 — `/auth/register` ENTFERNT.
        //
        // Sie war oeffentlich und UNAUTHENTIFIZIERT und legte tenant + branch + user an —
        // jeder im LAN konnte auf Port 3001 einen Tenant erzeugen. Ein Initial-Setup-Pfad
        // ist sie nie gewesen: `init_database` seedet tenant-1/branch-main/user-owner auf
        // jeder frischen DB, und im gesamten Repo gibt es **keinen einzigen Aufrufer**
        // (weder Frontend noch mobile_page). Eine tote, weit offene Write-Route zu gaten
        // waere schlechter, als sie zu entfernen: hier gibt es nichts zu erlauben.
        .route("/health", get(health))
        .merge(protected)
}

/// M6-B3A3 §3 — the SAME /api router production runs, with the raw-body limit applied, parametrized
/// by `body_limit`. The layer order is fixed here (body limit OUTSIDE the routes, so it runs before
/// the auth route_layer and the handler) and is identical for production and tests — only the limit
/// value differs. Production calls it with `MAX_SYNC_PUSH_BODY_BYTES`; the runtime integration test
/// calls it with a tiny limit to hit the exact boundary cheaply. `DefaultBodyLimit` returns 413
/// BEFORE the handler runs, so an oversized body never reaches the dup scan, a changelog write, a
/// quarantine write or an activity mark.
pub fn build_api_router(state: Arc<AppState>, body_limit: usize) -> Router<Arc<AppState>> {
    api_routes(state).layer(DefaultBodyLimit::max(body_limit))
}

async fn health() -> &'static str {
    "LATAIF Server OK"
}

async fn login(
    State(state): State<Arc<AppState>>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, StatusCode> {
    let db = state.db.lock().await;

    // M6-B2A4 — no login at all until this server has a provisioned owner.
    //
    // Checked SERVER-WIDE and BEFORE any user lookup, deliberately: the answer is a
    // property of the installation, not of an account, so it cannot be used to probe which
    // e-mails exist (§4, no user enumeration). Everything below it keeps returning a flat
    // 401.
    //
    // This is the LAN-facing half of the default-credential defect: `role` comes from
    // `user_branches`, so the shipped `admin@lataif.com`/`admin` used to return an OWNER
    // JWT here — and that JWT is what unlocks `/sync/push`.
    if !super::credentials::owner_credentials_ready(&db) {
        eprintln!(
            "[sync] login refused: {} — this server has no provisioned owner yet",
            super::primary::ERR_OWNER_PROVISIONING_REQUIRED
        );
        return Err(StatusCode::FORBIDDEN);
    }

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

    // M6-B2A4 — and per user: a provisioned SERVER does not make every account usable.
    // Indistinguishable from a wrong password on purpose — from here on, one flat 401.
    if !super::credentials::state_of(&db, &user_id).may_authenticate() {
        return Err(StatusCode::UNAUTHORIZED);
    }

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

// M6-B2A1: `register_tenant` samt Route entfernt — sie war eine unauthentifizierte,
// aufruferlose Write-Flaeche, die tenants/branches/users anlegte und ein Owner-JWT
// ausstellte. `init_database` seedet tenant-1/branch-main/user-owner ohnehin auf jeder
// frischen DB; ein Initial-Setup ueber HTTP wurde nie gebraucht.

async fn get_me(Extension(claims): Extension<Claims>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "user_id": claims.sub,
        "tenant_id": claims.tenant_id,
        "branch_id": claims.branch_id,
        "role": claims.role,
    }))
}

// M6-B1 — Legacy push batch, now ATOMIC.
//
// Before: each change was INSERTed in autocommit inside a bare loop. A failure at
// change N left changes 1..N-1 permanently committed, but the client sees only the
// 5xx and re-pushes the WHOLE batch (`pushChanges` marks `synced=1` only on 2xx)
// → the already-stored rows are inserted a second time. This closes exactly that
// partial-commit/full-retry gap and NOTHING else.
//
// The legacy contract is deliberately unchanged: no CAS, no base_revision, no
// field filtering, no per-change rejection, no protocol-version gate. Every change
// that would have been accepted before is still accepted, and the response body is
// byte-for-byte the same shape. This slice does NOT fix the stale-replay defect.
/// Why a legacy push batch was rejected. Distinct variants so `sync_push` can answer 403 for
/// a forbidden table (a policy decision) and 500 for a real DB failure — collapsing them
/// would tell an attacker probing control-plane tables the same thing a disk error tells an
/// honest client.
#[derive(Debug)]
pub enum PushBatchError {
    /// M6-B2DE1 §4 — the batch touched a control-plane or internal table.
    ControlPlaneForbidden(String),
    /// M6-B2DE3 §3 — a change carried a table_name that is not a canonical identifier. The
    /// server stores it as a bound value (no injection here), but a poisoned identifier in the
    /// shared changelog would detonate on every client that later applies it — so it is refused
    /// at the source. A malformed request, not a server fault: 400.
    InvalidIdentifier(String),
    /// M6-B3A §4 — a canonical, non-forbidden table that is NOT in the business-schema allowlist.
    /// `some_new_table` is no longer accepted by default. A malformed request: 400.
    TableNotAllowed(String),
    /// M6-B3A §5/§6 — the change violates the payload contract: a disallowed or non-canonical
    /// field, a malformed/oversized payload, or an operation the table does not permit. Carries
    /// the stable code so the operator log is specific. The confirmed products+invalid-key
    /// poisoning is refused here. A malformed request: 400.
    SchemaViolation { code: &'static str, table: String },
    Db(rusqlite::Error),
    /// §11 — the batch committed to the changelog but the legacy-activity invalidation could
    /// not be written. This must fail the whole push: a client landing data while the
    /// "everything is enrolled" flag silently survives is exactly the state §11 forbids.
    ActivityMarkFailed,
}

impl From<rusqlite::Error> for PushBatchError {
    fn from(e: rusqlite::Error) -> Self {
        PushBatchError::Db(e)
    }
}

pub fn apply_legacy_push_batch(
    conn: &mut rusqlite::Connection,
    tenant_id: &str,
    branch_id: &str,
    user_id: &str,
    now: &str,
    changes: &[SyncPushChange],
) -> Result<usize, PushBatchError> {
    // M6-B2DE1 §4 — isolate the control plane BEFORE the write lock and BEFORE any insert.
    //
    // Checked up front, across the WHOLE batch: the legacy sync is all-or-nothing, and a
    // batch that carries one forbidden row must write ZERO rows — not "everything up to the
    // bad one". A single `enrolled_devices` or `users` change poisons the entire batch. This
    // is a denylist (`SyncTablePolicy`), so normal business tables are untouched and there is
    // no certificate requirement and no blackout — only trust/identity tables are refused.
    for change in changes {
        if super::sync_policy::is_forbidden(&change.table_name) {
            // M6-B2DE4 §3 — never log the untrusted value raw. The refusal itself is the log; the
            // table name is redacted (bounded, control-chars stripped) in case a caller crafts one.
            eprintln!(
                "[sync] push refused: {} ({})",
                super::sync_policy::ERR_CONTROL_PLANE_TABLE_FORBIDDEN,
                super::sync_policy::redact_identifier(&change.table_name)
            );
            return Err(PushBatchError::ControlPlaneForbidden(change.table_name.clone()));
        }
        // M6-B2DE3 §3 — refuse a table_name that is not a canonical identifier. Stored here as a
        // bound value, so this is not an injection sink on the server — but it keeps a poisoned
        // identifier out of the shared changelog, where a client's apply path WOULD interpolate
        // it. No real business table is non-canonical, so this never rejects legitimate traffic;
        // the client validates again on apply (defence in depth).
        if super::sync_policy::validate_sync_table_name(&change.table_name).is_err() {
            // §3 — the untrusted value is REDACTED (a crafted table_name may carry newlines,
            // control bytes or a megabyte of data). Never the raw value in a log line.
            eprintln!(
                "[sync] push refused: {} ({})",
                super::sync_policy::ERR_TABLE_NAME_INVALID,
                super::sync_policy::redact_identifier(&change.table_name)
            );
            return Err(PushBatchError::InvalidIdentifier(change.table_name.clone()));
        }
        // M6-B3A §4 — the business allowlist. A canonical, non-forbidden name that is NOT in the
        // manifest is refused (SYNC_TABLE_NOT_ALLOWED) — `some_new_table` is no longer accepted by
        // default. Closes M6_FULL_BUSINESS_TABLE_ALLOWLIST_OPEN at the push ingress.
        if !super::sync_schema::is_business_table(&change.table_name) {
            eprintln!(
                "[sync] push refused: {} ({})",
                super::sync_schema::ERR_TABLE_NOT_ALLOWED,
                super::sync_policy::redact_identifier(&change.table_name)
            );
            return Err(PushBatchError::TableNotAllowed(change.table_name.clone()));
        }
        // M6-B3A1 §3 — the operation must be one the table's contract permits. allowed_operations is
        // the EXACT per-table set a production writer emits (not a blanket insert/update/delete), so an
        // insert into an update-only table, or a delete on an insert-only ledger, is refused here.
        if !super::sync_schema::is_operation_allowed(&change.table_name, &change.action) {
            eprintln!(
                "[sync] push refused: {} (op {} not permitted for table {})",
                super::sync_schema::ERR_OPERATION_NOT_ALLOWED,
                super::sync_policy::redact_identifier(&change.action),
                super::sync_policy::redact_identifier(&change.table_name)
            );
            return Err(PushBatchError::SchemaViolation {
                code: super::sync_schema::ERR_OPERATION_NOT_ALLOWED,
                table: change.table_name.clone(),
            });
        }
        // M6-B3A §5/§6 — insert/update payloads must satisfy the field/shape/limit contract. DELETE
        // carries no data contract (canonical, allow-listed table + bound record_id is enough). The
        // confirmed poisoning case — a canonical allow-listed table (`products`) carrying an invalid
        // or non-allowed payload column — is refused HERE, at the source, before it lands in the
        // changelog. Only a bounded, redacted diagnostic is logged: never the raw payload/fields.
        if change.action == "insert" || change.action == "update" {
            if let Err(code) = super::sync_schema::validate_business_payload(&change.table_name, &change.data) {
                eprintln!(
                    "[sync] push refused: {} (table {}, payload_hash {})",
                    code,
                    super::sync_policy::redact_identifier(&change.table_name),
                    super::sync_schema::digest_hex(&change.data)
                );
                return Err(PushBatchError::SchemaViolation { code, table: change.table_name.clone() });
            }
        }
    }

    // IMMEDIATE: take the write lock up front instead of upgrading mid-batch.
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    let mut count = 0usize;
    for change in changes {
        // `?` drops `tx` → rusqlite's Drop rolls back → zero rows survive a failure.
        tx.execute(
            "INSERT INTO sync_changelog (tenant_id, branch_id, table_name, record_id, action, data, user_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![tenant_id, branch_id, change.table_name, change.record_id, change.action, change.data, user_id, now],
        )?;
        count += 1;
    }

    // M6-B2DE1 §10/§11 — legacy activity, marked in the SAME transaction as the batch.
    //
    // This is observation, not a gate: the batch was already accepted above, and this cannot
    // reject it. But if an owner has attested the inventory complete, a legacy push proves an
    // un-enrolled device is still writing, which invalidates that completeness claim. Doing it
    // in this transaction is the §11 crash-safety contract: the changelog rows and the
    // readiness invalidation commit together or not at all — a client can never land data
    // while the "everything is enrolled" flag silently survives. `record_legacy_activity`
    // no-ops when there is no attestation, so normal pre-cutover operation is untouched.
    super::cutover::record_legacy_activity(&tx, tenant_id, branch_id, now)
        .map_err(|_| PushBatchError::ActivityMarkFailed)?;

    tx.commit()?;
    Ok(count)
}

/// M6-B3A4 §3 — does the request carry a JSON content-type? Restores the check the pre-B3A `Json`
/// extractor performed and the B3A `Bytes` switch silently dropped. Mirrors axum's `json_content_type`:
/// `application/json`, `application/json; charset=…` (parameters ignored) and any
/// `application/<vendor>+json` suffix are JSON; a missing header, `text/plain` and
/// `application/octet-stream` are not. Dependency-free (no `mime` crate) and case-insensitive on the
/// media type — every supported producer (desktop + mobile uploader, v0.8.23 + current) sends
/// `application/json`, so requiring a JSON content-type refuses nothing legitimate.
fn is_json_content_type(headers: &HeaderMap) -> bool {
    let Some(value) = headers.get(axum::http::header::CONTENT_TYPE) else {
        return false;
    };
    let Ok(text) = value.to_str() else {
        return false;
    };
    // media type = everything before the first ';' (drop parameters like charset), trimmed+lowercased
    let media = text.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    media == "application/json" || (media.starts_with("application/") && media.ends_with("+json"))
}

async fn sync_push(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    // M6-B3A4 §3 — the request headers, read ONLY to enforce the JSON content-type contract below. A
    // FromRequestParts extractor, so it precedes the Bytes body extractor.
    headers: HeaderMap,
    // M6-B3A1 §6 — take the RAW body (not the `Json` extractor) so a duplicate JSON key can be caught
    // BEFORE serde_json collapses it to the last value. Bytes must be the last extractor.
    body: axum::body::Bytes,
) -> Result<Json<serde_json::Value>, StatusCode> {
    // M6-B2A — central write gate. The ONLY state that may accept sync writes is a
    // primary whose recorded binding matches this installation. `should_serve()` already
    // kept client/unconfigured from listening at all; this catches read_only (a copied or
    // restored server DB) and is defence in depth for every future caller.
    if !state.primary_state.may_write_sync() {
        eprintln!(
            "[sync] push refused: {} (state '{}')",
            if state.primary_state == super::primary::State::ReadOnly {
                super::primary::ERR_SERVER_READ_ONLY
            } else {
                super::primary::ERR_PRIMARY_NOT_CONFIGURED
            },
            state.primary_state.as_str()
        );
        return Err(StatusCode::FORBIDDEN);
    }

    // M6-B3A4 §3 — restore the JSON content-type contract. Checked AFTER the write gate so a
    // non-writable server answers a uniform 403 (revealing no media-type policy), matching the
    // established B3A gate-first order. On a writable primary a non-JSON body (missing header,
    // text/plain, application/octet-stream) is 415 before the body is scanned or parsed. Every
    // supported producer sends `application/json`, so no legitimate client is refused.
    if !is_json_content_type(&headers) {
        eprintln!("[sync] push 415: unsupported media type (expected application/json)");
        return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }

    // M6-B3A1 §6 — refuse a raw body carrying a duplicate JSON key at the envelope level (two
    // `table_name`, `action`, `record_id`, `data`, …) before serde collapses it. The inner `data`
    // payload's own duplicate keys are refused later by the per-change field/shape validation. So no
    // duplicate — envelope or payload — can slip a value past the table/field/operation allowlists.
    let raw = std::str::from_utf8(&body).map_err(|_| StatusCode::BAD_REQUEST)?;
    if super::sync_schema::contains_duplicate_json_key(raw) {
        eprintln!(
            "[sync] push 400: {} (duplicate key in the push body)",
            super::sync_schema::ERR_PAYLOAD_DUPLICATE_KEY
        );
        return Err(StatusCode::BAD_REQUEST);
    }
    let req: SyncPushRequest = serde_json::from_str(raw).map_err(|_| StatusCode::BAD_REQUEST)?;

    let mut db = state.db.lock().await;
    let now = chrono::Utc::now().to_rfc3339();

    let count = apply_legacy_push_batch(
        &mut db,
        &claims.tenant_id,
        &claims.branch_id,
        &claims.sub,
        &now,
        &req.changes,
    )
    .map_err(|e| match e {
        // §4 — a forbidden table is a policy decision (403), not a server fault (500).
        // Answering 500 here would tell someone probing `enrolled_devices` the same thing a
        // disk error tells an honest client; 403 says "no" without the noise. The table name
        // and its policy class go to the operator log — useful for "why was my push refused?"
        // without echoing anything back to the caller.
        PushBatchError::ControlPlaneForbidden(table) => {
            // The name matched an exact control-plane entry (so it is a known, canonical token),
            // but redact it anyway for a single, uniform logging rule — no raw wire values.
            eprintln!(
                "[sync] push 403: table {} is {}",
                super::sync_policy::redact_identifier(&table),
                super::sync_policy::classify(&table).as_str()
            );
            StatusCode::FORBIDDEN
        }
        // §3 — a malformed identifier is a bad request, distinct from a policy refusal (403) and
        // a disk fault (500). 400 says "this could never be a real table" without the noise, and
        // the untrusted value is redacted.
        PushBatchError::InvalidIdentifier(table) => {
            eprintln!(
                "[sync] push 400: table name {} is not a canonical identifier",
                super::sync_policy::redact_identifier(&table)
            );
            StatusCode::BAD_REQUEST
        }
        // M6-B3A §4 — a canonical but non-allow-listed table. A bad request, redacted.
        PushBatchError::TableNotAllowed(table) => {
            eprintln!(
                "[sync] push 400: {} — table {} is not in the business allowlist",
                super::sync_schema::ERR_TABLE_NOT_ALLOWED,
                super::sync_policy::redact_identifier(&table)
            );
            StatusCode::BAD_REQUEST
        }
        // M6-B3A §5/§6 — a payload/operation contract violation. A bad request; the stable code and
        // the redacted table name are logged, never the raw payload.
        PushBatchError::SchemaViolation { code, table } => {
            eprintln!(
                "[sync] push 400: {} — table {}",
                code,
                super::sync_policy::redact_identifier(&table)
            );
            StatusCode::BAD_REQUEST
        }
        PushBatchError::Db(err) => {
            eprintln!("[sync] push 500: database error: {err}");
            StatusCode::INTERNAL_SERVER_ERROR
        }
        PushBatchError::ActivityMarkFailed => {
            eprintln!("[sync] push 500: could not persist legacy-activity invalidation");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    })?;

    Ok(Json(serde_json::json!({ "synced": count })))
}

#[derive(Deserialize)]
struct PullParams {
    since: Option<i64>,
}

/// M6-B2DE1 §5 / M6-B2DE4 §4 — split a scanned changelog window into what a legacy client may see,
/// how far its cursor may advance, and WHY each withheld row was withheld.
///
/// A pure function so the cursor contract can be tested without a live server (S9/S10). Two
/// classes of row are withheld — control-plane rows (a trust/identity table leaked into the
/// changelog) and rows whose `table_name` is not a canonical identifier (a poisoned identifier a
/// client must never interpolate). Both are dropped from the response but STILL counted by
/// `scanned_max`, so neither can become a permanent head-of-line block. The two counts are kept
/// SEPARATE (§4 diagnostics: `control_plane_filtered` vs `invalid_identifier`) — no raw attacker
/// value is retained. Business rows in the same window are untouched.
/// M6-B3A §8 — one changelog row the pull will WITHHOLD and permanently quarantine (never deliver),
/// so the cursor can advance past it without a head-of-line stall. The raw `table_name`/`record_id`/
/// `data` are kept only to compute a redacted name + hashes at persist time; never logged raw.
pub struct QuarantineCandidate {
    pub change_id: i64,
    pub table_name: String,
    pub record_id: String,
    pub data: String,
    pub reason_code: &'static str,
}

pub struct PullFilter {
    pub delivered: Vec<SyncChange>,
    pub scanned_max: i64,
    // §8 separated diagnostics.
    pub control_plane_filtered: usize,       // filtered only (expected internal/control rows)
    pub invalid_identifier_quarantined: usize,
    pub unknown_table_quarantined: usize,
    pub invalid_field_quarantined: usize,
    pub invalid_payload_quarantined: usize,
    // Every row that must be durably quarantined BEFORE the cursor may advance past it.
    pub to_quarantine: Vec<QuarantineCandidate>,
}

/// M6-B2DE1 §5 / M6-B3A §8 — split a scanned changelog window into what a legacy client may see, what
/// must be quarantined (and why), and how far the cursor may advance. A pure function so the whole
/// contract is unit-testable without a live server:
///   • valid allow-listed business row      → deliver
///   • control-plane / internal row          → filter (expected; not quarantined)
///   • non-canonical table identifier         → quarantine (SYNC_TABLE_NAME_INVALID)
///   • canonical but unknown table            → quarantine (SYNC_TABLE_NOT_ALLOWED)
///   • disallowed / non-canonical field        → quarantine (SYNC_FIELD_NOT_ALLOWED / _COLUMN_NAME_INVALID)
///   • malformed / oversized payload           → quarantine (SYNC_PAYLOAD_INVALID / _TOO_LARGE)
/// `scanned_max` is the highest id LOOKED AT — the cursor may reach it only once every withheld row
/// up to it is durably quarantined (enforced in `sync_pull`). No raw attacker value is retained here.
fn filter_forbidden_for_pull(rows: Vec<SyncChange>, since_id: i64) -> PullFilter {
    let scanned_max = rows.last().map(|c| c.id).unwrap_or(since_id);
    let mut delivered = Vec::new();
    let mut control_plane_filtered = 0usize;
    let mut invalid_identifier_quarantined = 0usize;
    let mut unknown_table_quarantined = 0usize;
    let mut invalid_field_quarantined = 0usize;
    let mut invalid_payload_quarantined = 0usize;
    let mut to_quarantine: Vec<QuarantineCandidate> = Vec::new();
    let mut quarantine = |c: &SyncChange, code: &'static str, counter: &mut usize| {
        *counter += 1;
        to_quarantine.push(QuarantineCandidate {
            change_id: c.id,
            table_name: c.table_name.clone(),
            record_id: c.record_id.clone(),
            data: c.data.clone(),
            reason_code: code,
        });
    };
    for c in rows {
        // The SAME classifier the client's `changeContractViolation` uses — so a row the client
        // would refuse on apply is exactly a row the server withholds on pull.
        match super::sync_schema::change_contract_violation(&c.table_name, &c.action, &c.data) {
            // A valid, allow-listed business row (incl. a DELETE, which has no payload contract).
            None => delivered.push(c),
            // Control-plane / internal rows are EXPECTED to be withheld (the server never should have
            // stored them; they are filtered, not quarantined — no operator follow-up needed).
            Some(code) if code == super::sync_policy::ERR_CONTROL_PLANE_TABLE_FORBIDDEN => {
                control_plane_filtered += 1;
            }
            Some(code) if code == super::sync_policy::ERR_TABLE_NAME_INVALID => {
                quarantine(&c, code, &mut invalid_identifier_quarantined);
            }
            Some(code) if code == super::sync_schema::ERR_TABLE_NOT_ALLOWED => {
                quarantine(&c, code, &mut unknown_table_quarantined);
            }
            Some(code)
                if code == super::sync_schema::ERR_FIELD_NOT_ALLOWED
                    || code == super::sync_schema::ERR_COLUMN_NAME_INVALID =>
            {
                quarantine(&c, code, &mut invalid_field_quarantined);
            }
            // SYNC_PAYLOAD_INVALID / SYNC_PAYLOAD_TOO_LARGE (incl. a disallowed operation).
            Some(code) => {
                quarantine(&c, code, &mut invalid_payload_quarantined);
            }
        }
    }
    PullFilter {
        delivered,
        scanned_max,
        control_plane_filtered,
        invalid_identifier_quarantined,
        unknown_table_quarantined,
        invalid_field_quarantined,
        invalid_payload_quarantined,
        to_quarantine,
    }
}

/// M6-B3A §8 — durably quarantine every withheld row in ONE immediate transaction, BEFORE the pull
/// returns its cursor. Deduped by `change_id` (idempotent re-scan bumps `occurrence_count`). Only a
/// redacted table name and hashes are stored — never raw payloads or secrets. `Err(())` on any DB
/// failure so `sync_pull` returns 500 and the client cursor does NOT advance past unquarantined rows.
fn persist_pull_quarantine(
    db: &mut rusqlite::Connection,
    tenant_id: &str,
    branch_id: &str,
    now: &str,
    rows: &[QuarantineCandidate],
) -> Result<(), ()> {
    if rows.is_empty() {
        return Ok(());
    }
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| ())?;
    for q in rows {
        let existing: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM sync_change_quarantine WHERE change_id = ?1",
                rusqlite::params![q.change_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| ())?;
        if existing.is_some() {
            tx.execute(
                "UPDATE sync_change_quarantine SET occurrence_count = occurrence_count + 1, \
                 last_seen_at = ?2, reason_code = ?3 WHERE change_id = ?1",
                rusqlite::params![q.change_id, now, q.reason_code],
            )
            .map_err(|_| ())?;
        } else {
            tx.execute(
                "INSERT INTO sync_change_quarantine \
                 (quarantine_id, change_id, source, tenant_id, branch_id, table_name_redacted, \
                  record_id_hash, payload_hash, reason_code, first_seen_at, last_seen_at, \
                  occurrence_count, state) \
                 VALUES (?1, ?2, 'pull_scan', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, 1, 'open')",
                rusqlite::params![
                    format!("q:{}", q.change_id),
                    q.change_id,
                    tenant_id,
                    branch_id,
                    super::sync_policy::redact_identifier(&q.table_name),
                    super::sync_schema::digest_hex(&q.record_id),
                    super::sync_schema::digest_hex(&q.data),
                    q.reason_code,
                    now,
                ],
            )
            .map_err(|_| ())?;
        }
    }
    tx.commit().map_err(|_| ())
}

/// M6-B2DE4 §7 — persist the legacy-activity marking for a successful pull in its OWN immediate
/// transaction. Returns `Err(())` if it cannot be persisted, so `sync_pull` must not return a
/// successful response — the pull's success and the readiness invalidation are one fate.
/// `record_legacy_activity` no-ops when there is no attestation, so ordinary pre-cutover pulling
/// is unaffected. Extracted so this exact contract is testable without a live axum handler.
fn record_pull_activity(
    db: &mut rusqlite::Connection,
    tenant_id: &str,
    branch_id: &str,
    now: &str,
) -> Result<(), ()> {
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| ())?;
    super::cutover::record_legacy_activity(&tx, tenant_id, branch_id, now).map_err(|_| ())?;
    tx.commit().map_err(|_| ())
}

async fn sync_pull(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Query(params): Query<PullParams>,
) -> Result<Json<SyncPullResponse>, StatusCode> {
    let mut db = state.db.lock().await;
    let since_id = params.since.unwrap_or(0);

    // Scan a window of changelog rows. `scanned_max` is the highest id we LOOKED AT, which is
    // not the same as the highest id we RETURN once forbidden/invalid rows are filtered out —
    // and that distinction is the whole of §5.
    let filtered = {
        let mut stmt = db
            .prepare(
                "SELECT id, table_name, record_id, branch_id, action, data, created_at
                 FROM sync_changelog
                 WHERE tenant_id = ?1 AND id > ?2
                 ORDER BY id ASC LIMIT 1000",
            )
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        let rows: Vec<SyncChange> = stmt
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

        filter_forbidden_for_pull(rows, since_id)
    };

    // §8 — durably QUARANTINE every withheld invalid row BEFORE the cursor is allowed to advance
    // past it. Quarantine persistence and the cursor decision are one fate: if this fails, the pull
    // returns 500 and the client's cursor stays put → the same window is re-scanned and re-quarantined
    // (idempotent by change_id). This is what lets `scanned_max` move past a poisoned row without ever
    // delivering it — closing the head-of-line DoS — while never marking it applied.
    {
        let now = chrono::Utc::now().to_rfc3339();
        persist_pull_quarantine(&mut db, &claims.tenant_id, &claims.branch_id, &now, &filtered.to_quarantine)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }

    // §8 — separated diagnostics, counts only (no raw attacker value ever reaches a log line).
    let q_total = filtered.invalid_identifier_quarantined
        + filtered.unknown_table_quarantined
        + filtered.invalid_field_quarantined
        + filtered.invalid_payload_quarantined;
    if filtered.control_plane_filtered > 0 || q_total > 0 {
        eprintln!(
            "[sync] pull withheld: control_plane_filtered={} invalid_identifier_quarantined={} \
             unknown_table_quarantined={} invalid_field_quarantined={} invalid_payload_quarantined={}",
            filtered.control_plane_filtered,
            filtered.invalid_identifier_quarantined,
            filtered.unknown_table_quarantined,
            filtered.invalid_field_quarantined,
            filtered.invalid_payload_quarantined
        );
    }
    let (delivered, scanned_max) = (filtered.delivered, filtered.scanned_max);

    // §10/§11/§7 — a successful, authenticated legacy pull is legacy activity. After an
    // attestation, an un-enrolled device still pulling means the "everything is enrolled" claim is
    // stale. The marking is persisted BEFORE the response is returned, and a failure to persist it
    // must fail the pull (no successful response while readiness silently survives). Extracted into
    // `record_pull_activity` so exactly this fate-sharing is unit-testable (§7).
    {
        let now = chrono::Utc::now().to_rfc3339();
        record_pull_activity(&mut db, &claims.tenant_id, "branch-main", &now)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }

    Ok(Json(SyncPullResponse {
        changes: delivered,
        // The cursor is `scanned_max`, not `delivered.last()`. If the only rows in this window
        // were control-plane rows, `delivered` is empty but the cursor still moves — otherwise
        // the client would re-request the same forbidden rows forever.
        last_sync_id: scanned_max,
    }))
}

// "Check Item": Produkt per SKU nachschlagen und volle Details (inkl. Foto) zurueckgeben.
// PRIMAER aus der Frontend-DB (lataif.db) `products`-Tabelle lesen — die ist die SSOT
// mit aktuellem, vollstaendigem Bild. Der Sync-Changelog transportiert Bilder unzuverlaessig
// (Bild landet teils nie/veraltet in der gepushten Zeile), daher dient er nur als Fallback.
async fn product_by_sku(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(sku): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    // 1) Direkt aus lataif.db (read-only). Liefert immer das aktuelle Bild.
    if let Some(p) = product_from_frontend_db(&state.frontend_db_path, &sku) {
        return Ok(Json(p));
    }
    // 2) Fallback: bisheriger Changelog-Lookup in der Sync-Server-DB.
    let db = state.db.lock().await;

    // Neuste Changelog-Zeile mit dieser SKU (gibt record_id + volle Daten).
    let found: Result<(String, String), _> = db
        .prepare(
            "SELECT record_id, data FROM sync_changelog
             WHERE tenant_id = ?1 AND table_name = 'products'
               AND json_extract(data, '$.sku') = ?2
             ORDER BY id DESC LIMIT 1",
        )
        .and_then(|mut stmt| {
            stmt.query_row(rusqlite::params![claims.tenant_id, sku], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
        });
    let (record_id, data) = found.map_err(|_| StatusCode::NOT_FOUND)?;

    // Wurde das Produkt seither geloescht? (neuste Aktion fuer die record_id pruefen)
    let latest_action: Result<String, _> = db
        .prepare(
            "SELECT action FROM sync_changelog
             WHERE tenant_id = ?1 AND table_name = 'products' AND record_id = ?2
             ORDER BY id DESC LIMIT 1",
        )
        .and_then(|mut stmt| {
            stmt.query_row(rusqlite::params![claims.tenant_id, record_id], |row| {
                row.get(0)
            })
        });
    if latest_action.unwrap_or_default() == "delete" {
        return Err(StatusCode::NOT_FOUND);
    }

    let mut product: serde_json::Value =
        serde_json::from_str(&data).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Kategorie-Name aufloesen (fuer die Anzeige).
    if let Some(cat_id) = product
        .get("category_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
    {
        let cat_name: Result<String, _> = db
            .prepare(
                "SELECT json_extract(data, '$.name') FROM sync_changelog
                 WHERE tenant_id = ?1 AND table_name = 'categories' AND record_id = ?2
                 ORDER BY id DESC LIMIT 1",
            )
            .and_then(|mut stmt| {
                stmt.query_row(rusqlite::params![claims.tenant_id, cat_id], |row| {
                    row.get(0)
                })
            });
        if let Ok(name) = cat_name {
            product["category_name"] = serde_json::Value::String(name);
        }
    }

    Ok(Json(product))
}

// Zahlen-Spalte tolerant lesen: Real/Integer → Zahl, numerischer Text → geparst,
// alles andere (NULL, leerer Text, der String "null" aus Alt-Daten) → None.
// Verhindert, dass query_row an einem als TEXT gespeicherten Preisfeld scheitert.
fn col_num(r: &rusqlite::Row, idx: usize) -> Option<f64> {
    use rusqlite::types::ValueRef;
    match r.get_ref(idx) {
        Ok(ValueRef::Real(f)) => Some(f),
        Ok(ValueRef::Integer(i)) => Some(i as f64),
        Ok(ValueRef::Text(t)) => std::str::from_utf8(t)
            .ok()
            .and_then(|s| s.trim().parse::<f64>().ok()),
        _ => None,
    }
}

#[cfg(test)]
mod legacy_push_tests {
    use super::*;
    use rusqlite::Connection;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            // Kept deliberately minimal — WITHOUT the three v0001 protocol columns — so that
            // `legacy_push_writes_no_protocol_fields` can add and test them itself.
            "CREATE TABLE sync_changelog (
                id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
                branch_id TEXT NOT NULL, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
                action TEXT NOT NULL, data TEXT NOT NULL, user_id TEXT, created_at TEXT NOT NULL
            );
            -- M6-B2DE1: apply_legacy_push_batch now marks legacy activity in-transaction, and
            -- that reads sync_cutover_state. `foreign_keys` is OFF on a bare connection, so the
            -- table's FK targets need not exist; with no attestation row present it is a pure
            -- read that no-ops, leaving the changelog semantics these tests check untouched.
            CREATE TABLE sync_cutover_state (
                tenant_id TEXT NOT NULL, branch_id TEXT NOT NULL, state TEXT NOT NULL,
                inventory_revision INTEGER NOT NULL DEFAULT 1, current_attestation_id TEXT,
                protocol_v4_write_path_ready INTEGER NOT NULL DEFAULT 0,
                legacy_activity_after_attestation INTEGER NOT NULL DEFAULT 0,
                last_legacy_activity_at TEXT, blocked_reason TEXT,
                updated_at TEXT NOT NULL, updated_by TEXT,
                PRIMARY KEY (tenant_id, branch_id)
            );",
        )
        .unwrap();
        conn
    }

    fn change(record_id: &str) -> SyncPushChange {
        change_on("products", record_id, "update")
    }

    fn change_on(table: &str, record_id: &str, action: &str) -> SyncPushChange {
        SyncPushChange {
            table_name: table.into(),
            record_id: record_id.into(),
            action: action.into(),
            data: format!("{{\"id\":\"{record_id}\"}}"),
        }
    }

    fn is_forbidden_err(r: &Result<usize, PushBatchError>) -> bool {
        matches!(r, Err(PushBatchError::ControlPlaneForbidden(_)))
    }

    fn rows(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM sync_changelog", [], |r| r.get(0))
            .unwrap()
    }

    /// Controlled, deterministic DB failure for exactly one record id — stands in
    /// for any mid-batch INSERT error (disk, constraint, corruption).
    fn fail_on(conn: &Connection, record_id: &str) {
        conn.execute_batch(&format!(
            "CREATE TRIGGER boom BEFORE INSERT ON sync_changelog
             WHEN NEW.record_id = '{record_id}'
             BEGIN SELECT RAISE(ABORT, 'controlled test failure'); END;"
        ))
        .unwrap();
    }

    fn push(conn: &mut Connection, changes: &[SyncPushChange]) -> Result<usize, PushBatchError> {
        apply_legacy_push_batch(conn, "tenant-1", "branch-main", "self-desktop", "2026-07-16", changes)
    }

    // ── A: 3 valid changes → all 3 committed ────────────────────────────────
    #[test]
    fn a_all_valid_changes_commit() {
        let mut conn = db();
        let n = push(&mut conn, &[change("p1"), change("p2"), change("p3")]).unwrap();
        assert_eq!(n, 3);
        assert_eq!(rows(&conn), 3);
    }

    // ── B: change 2 fails → 0 committed (the actual M6-B1 fix) ──────────────
    #[test]
    fn b_failure_in_the_middle_commits_nothing() {
        let mut conn = db();
        fail_on(&conn, "p2");
        let err = push(&mut conn, &[change("p1"), change("p2"), change("p3")]);
        assert!(err.is_err(), "batch must fail");
        assert_eq!(
            rows(&conn),
            0,
            "no partial commit: change 1 must NOT survive a failure at change 2"
        );
    }

    // ── C: retry after a failed batch → committed exactly once ─────────────
    #[test]
    fn c_retry_after_failure_commits_exactly_once() {
        let mut conn = db();
        fail_on(&conn, "p2");
        assert!(push(&mut conn, &[change("p1"), change("p2"), change("p3")]).is_err());
        assert_eq!(rows(&conn), 0);

        // Client re-pushes the identical batch (it never marked synced=1).
        // Failure cause removed → full batch lands, and p1 is NOT duplicated.
        conn.execute_batch("DROP TRIGGER boom;").unwrap();
        let n = push(&mut conn, &[change("p1"), change("p2"), change("p3")]).unwrap();
        assert_eq!(n, 3);
        assert_eq!(rows(&conn), 3, "exactly one full commit, no duplicate of change 1");
        let p1: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_changelog WHERE record_id='p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(p1, 1);
    }

    // ── D: stored content + row shape identical to the legacy semantics ─────
    #[test]
    fn d_successful_legacy_payload_is_stored_exactly_as_before() {
        let mut conn = db();
        push(&mut conn, &[change("p1")]).unwrap();
        let (tenant, branch, table, record, action, data, user, created): (
            String, String, String, String, String, String, String, String,
        ) = conn
            .query_row(
                "SELECT tenant_id, branch_id, table_name, record_id, action, data, user_id, created_at
                 FROM sync_changelog WHERE id=1",
                [],
                |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?))
                },
            )
            .unwrap();
        assert_eq!(
            (tenant.as_str(), branch.as_str(), table.as_str(), record.as_str()),
            ("tenant-1", "branch-main", "products", "p1")
        );
        assert_eq!(action, "update");
        assert_eq!(data, "{\"id\":\"p1\"}", "payload stored verbatim — no filtering");
        assert_eq!(user, "self-desktop", "writer still taken from the JWT subject");
        assert_eq!(created, "2026-07-16");
    }

    // ── Empty batch stays a no-op (unchanged legacy behaviour) ─────────────
    #[test]
    fn empty_batch_is_a_noop() {
        let mut conn = db();
        assert_eq!(push(&mut conn, &[]).unwrap(), 0);
        assert_eq!(rows(&conn), 0);
    }

    // ── W4: Write-Surface-Nachweis am QUELLTEXT ──────────────────────────────
    //
    // Der Anspruch ist nicht "sync_push hat ein Gate", sondern: es gibt KEINE zweite
    // mutierende Flaeche, die daran vorbei schreibt. Deshalb wird die Routenmenge und die
    // Menge der Schreibzugriffe geprueft, nicht nur ein Handler.
    #[test]
    fn w4_every_mutating_route_is_gated() {
        let src = include_str!("routes.rs");
        let code: String = src
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        let prod = &code[..code.find("#[cfg(test)]").unwrap_or(code.len())];

        // 1. Die unauthentifizierte Registerroute existiert nicht mehr.
        assert!(!prod.contains("register_tenant"), "W1/W2/W3: /auth/register muss entfernt sein");

        // 2. Welche Routen gibt es ueberhaupt?
        let routes: Vec<&str> = prod
            .match_indices(".route(\"")
            .map(|(i, _)| {
                let rest = &prod[i + 8..];
                &rest[..rest.find('"').unwrap()]
            })
            .collect();
        assert_eq!(
            routes,
            vec!["/sync/push", "/sync/pull", "/me", "/products/by-sku/{sku}", "/auth/login", "/health"],
            "Routenmenge geaendert — Modusmatrix und Gate neu bewerten"
        );

        // 3. Jeder Schreibzugriff im Produktivcode geht entweder in sync_changelog (Business-Daten,
        //    also durch apply_legacy_push_batch hinter dem Gate) ODER in sync_change_quarantine
        //    (M6-B3A §8: internes Quarantaene-Bookkeeping auf dem authentifizierten Pull-Pfad — keine
        //    Business-Daten, nur redigierte Hashes). Keine dritte, ungegatete Schreibflaeche.
        let writers: Vec<&str> = ["INSERT INTO", "UPDATE ", "DELETE FROM"]
            .iter()
            .flat_map(|kw| prod.match_indices(kw).map(|(i, _)| &prod[i..(i + 40).min(prod.len())]))
            .collect();
        for w in &writers {
            assert!(
                w.contains("sync_changelog") || w.contains("sync_change_quarantine"),
                "unerwartete Schreibflaeche im Produktivcode: {w:?} — muss changelog (Gate) oder quarantine (B3A) sein"
            );
        }
        assert!(!writers.is_empty(), "Sanity: der Scanner sieht ueberhaupt Schreibzugriffe");
        assert!(prod.contains("may_write_sync()"), "sync_push muss das zentrale Gate aufrufen");
    }

    // ── W5: Lesepfade veraendern die DB nicht ────────────────────────────────
    #[test]
    fn w5_read_routes_do_not_write() {
        let src = include_str!("routes.rs");
        for handler in ["async fn sync_pull", "async fn get_me", "async fn product_by_sku", "async fn health"] {
            let start = src.find(handler).unwrap_or_else(|| panic!("{handler} nicht gefunden"));
            // Bis zur NAECHSTEN Top-Level-Funktion, nicht ueber ein festes Zeichenfenster —
            // sonst laeuft der Scan in den Nachbarcode und misst das Falsche.
            let rest = &src[start + handler.len()..];
            let end = ["\nasync fn ", "\nfn ", "\npub fn ", "\npub async fn "]
                .iter()
                .filter_map(|m| rest.find(m))
                .min()
                .map(|i| start + handler.len() + i)
                .unwrap_or(src.len());
            let body = &src[start..end];
            for kw in ["INSERT INTO", "UPDATE ", "DELETE FROM"] {
                assert!(!body.contains(kw), "{handler} darf nicht schreiben (fand {kw})");
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // M6-B2DE1 §13 — control-plane isolation, PUSH side (S1–S8).
    // ═══════════════════════════════════════════════════════════════════════

    // ── S1–S6: a legacy push touching any control-plane table → whole batch refused
    #[test]
    fn s1_to_s6_control_plane_push_rejects_the_whole_batch() {
        for table in [
            "enrolled_devices",      // S1
            "device_certificates",   // S2
            "device_revocations",    // S3
            "sync_cutover_state",    // S4
            "tenant_trust_roots",    // S5
            "root_custody",          // S6
        ] {
            let mut conn = db();
            let r = push(&mut conn, &[change_on(table, "x", "update")]);
            assert!(is_forbidden_err(&r), "{table}: must be refused");
            assert_eq!(rows(&conn), 0, "{table}: no changelog row written");
        }
    }

    // ── the rejection names the offending table (for diagnostics) ────────────
    #[test]
    fn the_forbidden_error_carries_the_table_name() {
        let mut conn = db();
        let r = push(&mut conn, &[change_on("enrolled_devices", "d1", "insert")]);
        match r {
            Err(PushBatchError::ControlPlaneForbidden(table)) => {
                assert_eq!(table, "enrolled_devices", "the error names which table was refused");
            }
            other => panic!("expected ControlPlaneForbidden, got {other:?}"),
        }
        // And a DB error is a distinct, debuggable variant — not collapsed into the policy one.
        fail_on(&conn, "p1");
        let db_err = push(&mut conn, &[change("p1")]);
        assert!(matches!(db_err, Err(PushBatchError::Db(_))), "a real DB failure stays Db(_)");
        assert!(format!("{db_err:?}").contains("Db"), "the underlying error is preserved for logs");
    }

    // ── S7: a mixed business + control-plane batch writes NOTHING ────────────
    #[test]
    fn s7_mixed_batch_writes_nothing() {
        let mut conn = db();
        // A perfectly good business change FOLLOWED by a forbidden one. All-or-nothing means
        // the good one must not survive either — a single poisoned row rejects the batch.
        let r = push(
            &mut conn,
            &[change("p1"), change_on("enrolled_devices", "d1", "insert"), change("p2")],
        );
        assert!(is_forbidden_err(&r), "S7: mixed batch must be refused");
        assert_eq!(rows(&conn), 0, "S7: not even the business row before the bad one survives");
    }

    // ── S8: a normal business batch is unaffected ────────────────────────────
    #[test]
    fn s8_business_batch_still_succeeds() {
        let mut conn = db();
        let n = push(&mut conn, &[change("p1"), change("p2")]).unwrap();
        assert_eq!(n, 2, "S8: business tables keep flowing — no certificate requirement, no blackout");
        assert_eq!(rows(&conn), 2);
    }

    // ── S12: a DELETE on a control-plane table is blocked too ────────────────
    #[test]
    fn s12_control_plane_delete_is_also_blocked() {
        let mut conn = db();
        let r = push(&mut conn, &[change_on("users", "u1", "delete")]);
        assert!(is_forbidden_err(&r), "S12: delete on a control-plane table is refused, like insert/update");
        assert_eq!(rows(&conn), 0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // M6-B2DE1 §13 — control-plane isolation, PULL side (S9–S10).
    // ═══════════════════════════════════════════════════════════════════════

    fn pull_row(id: i64, table: &str) -> SyncChange {
        SyncChange {
            id,
            table_name: table.into(),
            record_id: format!("r{id}"),
            branch_id: "branch-main".into(),
            action: "update".into(),
            data: "{}".into(),
            created_at: "n".into(),
        }
    }

    // ── S9: a control-plane row already in the changelog is NOT delivered ────
    #[test]
    fn s9_control_plane_rows_are_never_delivered() {
        // A window that mixes business and a leaked control-plane row (id 2).
        let scanned = vec![
            pull_row(1, "products"),
            pull_row(2, "enrolled_devices"),
            pull_row(3, "invoices"),
        ];
        let f = filter_forbidden_for_pull(scanned, 0);
        assert_eq!(f.delivered.len(), 2, "the control-plane row is withheld");
        assert!(f.delivered.iter().all(|c| c.table_name != "enrolled_devices"));
        assert!(f.delivered.iter().any(|c| c.table_name == "products"));
        assert!(f.delivered.iter().any(|c| c.table_name == "invoices"));
        // ── S10: …and the cursor still advances past it (id 3), no head-of-line block.
        assert_eq!(f.scanned_max, 3, "S10: cursor advances past the withheld row, not stuck at it");
        // §4 — the diagnostics separate the two withholding reasons.
        assert_eq!(f.control_plane_filtered, 1, "the enrolled_devices row is control-plane");
        assert_eq!(f.invalid_identifier_quarantined, 0);
    }

    // ── S10: a window of ONLY control-plane rows delivers nothing but advances ─
    #[test]
    fn s10_all_forbidden_window_still_advances_the_cursor() {
        let scanned = vec![pull_row(5, "root_custody"), pull_row(6, "device_certificates")];
        let f = filter_forbidden_for_pull(scanned, 4);
        assert!(f.delivered.is_empty(), "nothing deliverable…");
        assert_eq!(f.scanned_max, 6, "…but the cursor moves to 6, so the client never re-requests them");
        assert_eq!(f.control_plane_filtered, 2);
    }

    // ── an empty window leaves the cursor where it was ───────────────────────
    #[test]
    fn empty_pull_window_keeps_the_cursor() {
        let f = filter_forbidden_for_pull(vec![], 42);
        assert!(f.delivered.is_empty());
        assert_eq!(f.scanned_max, 42, "no rows scanned → cursor unchanged");
    }

    // ── S11/S12: the CLIENT apply guard blocks all three actions on control-plane
    //
    // The client guard lives in `apply-change.ts` (M6-B2DE4 §5). This is a SECONDARY structural
    // check — the PRIMARY proof is the behavioral gate `test/m6b2de4/*.test.ts`, which drives the
    // real `applySyncChange` against a real sql.js database. Here we only confirm the guard is
    // POSITIONED before every apply branch.
    #[test]
    fn s11_s12_client_guard_precedes_every_apply_action() {
        let ts = include_str!("../../../src/core/sync/apply-change.ts");
        let guard = ts
            .find("classifySyncTable(change.table_name)")
            .expect("the client apply guard must exist");
        let upsert = ts.find("applyUpsert(db, change.table_name").expect("applyUpsert call");
        let delete = ts.find("DELETE FROM ${change.table_name}").expect("delete path");
        // Find the guard INSIDE applyChange, then assert both the upsert and the delete come
        // after it — so a control-plane row is refused before any of the three can run.
        assert!(guard < upsert, "guard must precede the insert/update path");
        assert!(guard < delete, "guard must precede the delete path");
        // …and it throws (fail-closed), not merely skips.
        let after = &ts[guard..upsert];
        assert!(after.contains("throw new SyncPoisonError"), "the guard must throw, not silently skip");
        assert!(
            after.contains("SYNC_CONTROL_PLANE_TABLE_FORBIDDEN"),
            "and it must carry the stable error code"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // M6-B2DE2 §3 — EXHAUSTIVE, table-driven. Not six sample tables: every
    // forbidden table (all 16 control-plane + all 4 internal) driven through
    // push and pull. A denylist tested on a remembered subset has holes.
    // ═══════════════════════════════════════════════════════════════════════

    fn all_forbidden_tables() -> Vec<&'static str> {
        crate::sync::sync_policy::CONTROL_PLANE_TABLES
            .iter()
            .chain(crate::sync::sync_policy::INTERNAL_TABLES.iter())
            .copied()
            .collect()
    }

    // ── every forbidden table is refused by push, alone and inside a mixed batch ──
    #[test]
    fn every_forbidden_table_is_rejected_by_push() {
        let forbidden = all_forbidden_tables();
        assert_eq!(forbidden.len(), 21, "16 control-plane + 5 internal (incl. sync_change_quarantine)");
        for table in forbidden {
            let mut conn = db();
            let r = push(&mut conn, &[change_on(table, "x", "update")]);
            assert!(is_forbidden_err(&r), "{table}: a push touching it must be refused");
            assert_eq!(rows(&conn), 0, "{table}: no changelog row written");

            // …and a business change either side of it does not survive: all-or-nothing.
            let mut conn2 = db();
            let r2 =
                push(&mut conn2, &[change("ok1"), change_on(table, "x", "delete"), change("ok2")]);
            assert!(is_forbidden_err(&r2), "{table}: mixed batch refused");
            assert_eq!(rows(&conn2), 0, "{table}: the surrounding business rows do not survive");
        }
    }

    // ── every forbidden table is withheld by pull; the cursor still advances past it ──
    #[test]
    fn every_forbidden_table_is_withheld_by_pull() {
        for table in all_forbidden_tables() {
            let scanned =
                vec![pull_row(1, "products"), pull_row(2, table), pull_row(3, "invoices")];
            let f = filter_forbidden_for_pull(scanned, 0);
            assert!(f.delivered.iter().all(|c| c.table_name != table), "{table}: withheld from pull");
            assert_eq!(f.delivered.len(), 2, "{table}: the two business rows still flow");
            assert_eq!(f.scanned_max, 3, "{table}: cursor advances past the withheld row (no HOL block)");
            // Every forbidden table is a canonical control-plane/internal name → control-plane count.
            assert_eq!(f.control_plane_filtered, 1, "{table}: counted as control-plane");
            assert_eq!(f.invalid_identifier_quarantined, 0);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // M6-B2DE3 §3 — dynamic identifier safety. A non-canonical table_name is
    // refused at push (defence in depth), and the CLIENT gates every identifier
    // before it can reach SQL.
    // ═══════════════════════════════════════════════════════════════════════

    // ── a non-canonical table_name is refused by push (400), a clean one flows ──
    #[test]
    fn non_canonical_table_name_is_rejected_by_push() {
        let mut attacks: Vec<String> = [
            "Products",                    // uppercase — SQLite folds case, our canonical form does not
            "1table",                      // leading digit
            "_hidden",                     // leading underscore
            "foo bar",                     // space
            "foo\"; DROP TABLE users; --", // the classic identifier break-out
            "foo;bar",                     // statement separator
            "foo-bar",                     // hyphen
            "",                            // empty
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        attacks.push("a".repeat(65)); // oversized

        for bad in &attacks {
            let mut conn = db();
            let r = push(&mut conn, &[change_on(bad, "x", "update")]);
            assert!(
                matches!(r, Err(PushBatchError::InvalidIdentifier(_))),
                "{bad:?}: must be refused as a non-canonical identifier"
            );
            assert_eq!(rows(&conn), 0, "{bad:?}: no changelog row written");
        }
        // M6-B3A §4 — a canonical but UNKNOWN business table is now REFUSED (SYNC_TABLE_NOT_ALLOWED).
        // This is the M6_FULL_BUSINESS_TABLE_ALLOWLIST_OPEN boundary, now CLOSED: the gate is the
        // manifest allowlist, not merely a charset.
        let mut conn = db();
        let r = push(&mut conn, &[change_on("some_new_table", "x", "update")]);
        assert!(
            matches!(r, Err(PushBatchError::TableNotAllowed(_))),
            "an unknown but canonical table is now refused as not-allowed — got {r:?}"
        );
        assert_eq!(rows(&conn), 0, "no changelog row for a non-allow-listed table");
    }

    // ── the CLIENT apply gates every identifier BEFORE building any SQL ──────
    //
    // The apply path lives in TypeScript; here we prove the gates are POSITIONED to run before
    // the string-building sinks — the table gate before applyUpsert and the DELETE, the column
    // gate before the SET/INSERT construction inside applyUpsert.
    #[test]
    fn client_apply_gates_identifiers_before_building_sql() {
        // Secondary structural check; the PRIMARY proof is the behavioral gate in
        // `test/m6b2de4/*.test.ts`. Reads `apply-change.ts` where the dispatcher now lives.
        let ts = include_str!("../../../src/core/sync/apply-change.ts");

        let table_gate = ts
            .find("assertSyncIdentifier('table', change.table_name)")
            .expect("the dispatcher table gate must exist");
        let upsert = ts.find("applyUpsert(db, change.table_name").expect("applyUpsert call");
        let delete = ts.find("DELETE FROM ${change.table_name}").expect("delete path");
        assert!(table_gate < upsert, "table gate must precede applyUpsert");
        assert!(table_gate < delete, "table gate must precede the DELETE");

        // Inside applyUpsert, the column gate precedes the SET clause and the INSERT column list.
        let f = ts.find("function applyUpsert").expect("applyUpsert definition");
        let col_gate = ts[f..]
            .find("assertSyncIdentifier('column', k)")
            .map(|i| i + f)
            .expect("the column gate must exist inside applyUpsert");
        let set_clause = ts[f..].find("const setClause").map(|i| i + f).expect("setClause build");
        // Needle unique to the actual INSERT statement — NOT `INSERT INTO ${table}`, which also
        // appears in applyUpsert's own doc comment above (the recursive source-scan trap).
        let insert = ts[f..].find("(${allKeys.join").map(|i| i + f).expect("insert column list build");
        assert!(col_gate < set_clause, "column gate must precede the SET clause");
        assert!(col_gate < insert, "column gate must precede the INSERT column list");

        // …and the table gate inside applyUpsert precedes both, too (reusable sink, self-guarding).
        let upsert_table_gate = ts[f..]
            .find("assertSyncIdentifier('table', table)")
            .map(|i| i + f)
            .expect("applyUpsert must gate its own table argument");
        assert!(upsert_table_gate < set_clause);
        assert!(upsert_table_gate < insert);

        // The gate is fail-closed: assertSyncIdentifier throws the stable error code inside its
        // own body (find-based bounds so we never byte-slice into the file's non-ASCII comments).
        let g = ts.find("function assertSyncIdentifier").expect("assertSyncIdentifier definition");
        let body_end = ts[g + 10..]
            .find("\nfunction ")
            .or_else(|| ts[g + 10..].find("\nexport "))
            .or_else(|| ts[g + 10..].find("\nlet "))
            .map(|i| i + g + 10)
            .unwrap_or(ts.len());
        let throws = ts[g..body_end].contains("throw new SyncPoisonError");
        let coded = ts[g..body_end].contains("SYNC_TABLE_NAME_INVALID")
            && ts[g..body_end].contains("SYNC_COLUMN_NAME_INVALID");
        assert!(throws, "the identifier gate must throw, not silently skip");
        assert!(coded, "and it must carry the stable table AND column error codes");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // M6-B2DE2 §9 — legacy activity, re-confirmed. After an attestation, a
    // successful legacy sync invalidates readiness IN THE SAME breath; a
    // refused push does not count; legacy sync stays allowed (no blackout).
    // ═══════════════════════════════════════════════════════════════════════

    /// A cutover DB where the owner HAS attested — so `record_legacy_activity` is armed and any
    /// successful legacy sync must invalidate readiness together with landing its data.
    fn db_with_attestation() -> Connection {
        let conn = db();
        conn.execute(
            "INSERT INTO sync_cutover_state
               (tenant_id, branch_id, state, inventory_revision, current_attestation_id,
                protocol_v4_write_path_ready, legacy_activity_after_attestation, updated_at)
             VALUES ('tenant-1','branch-main','ready_for_protocol_activation',1,'att-1',0,0,'2026-07-16')",
            [],
        )
        .unwrap();
        conn
    }

    fn cutover_flags(conn: &Connection) -> (i64, String) {
        conn.query_row(
            "SELECT legacy_activity_after_attestation, state FROM sync_cutover_state
              WHERE tenant_id='tenant-1' AND branch_id='branch-main'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    // ── a successful legacy push lands the batch AND invalidates readiness, together ──
    #[test]
    fn successful_push_invalidates_readiness_in_the_same_transaction() {
        let mut conn = db_with_attestation();
        let n = push(&mut conn, &[change("p1"), change("p2")]).unwrap();
        assert_eq!(n, 2);
        assert_eq!(rows(&conn), 2, "the business batch landed — legacy sync stays allowed");
        let (flag, state) = cutover_flags(&conn);
        assert_eq!(flag, 1, "§9: legacy activity after attestation is recorded");
        assert_eq!(state, "activation_blocked", "§9: readiness is invalidated by the activity");
    }

    // ── a refused control-plane push is NOT a successful sync → does not count ──
    #[test]
    fn rejected_control_plane_push_does_not_count_as_activity() {
        let mut conn = db_with_attestation();
        let r = push(&mut conn, &[change_on("enrolled_devices", "d1", "insert")]);
        assert!(is_forbidden_err(&r));
        assert_eq!(rows(&conn), 0);
        let (flag, state) = cutover_flags(&conn);
        assert_eq!(flag, 0, "§9: a refused push is not activity — readiness stands");
        assert_eq!(state, "ready_for_protocol_activation", "state untouched");
    }

    // ── §11 — the batch and the invalidation are ONE transaction: a mid-batch failure
    //    rolls back BOTH, never landing data while the flag silently survives ──
    #[test]
    fn a_failed_push_rolls_back_both_the_batch_and_the_invalidation() {
        let mut conn = db_with_attestation();
        fail_on(&conn, "p2");
        assert!(push(&mut conn, &[change("p1"), change("p2")]).is_err());
        assert_eq!(rows(&conn), 0, "no changelog rows survive");
        let (flag, state) = cutover_flags(&conn);
        assert_eq!(flag, 0, "§11: the invalidation did not commit either — one transaction");
        assert_eq!(state, "ready_for_protocol_activation");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // M6-B2DE4 §2 — the table-driven policy-bypass MATRIX. Five control-plane
    // tables × every dangerous variant, through PUSH and PULL. A canonical
    // forbidden name → ControlPlaneForbidden; ANY non-canonical form →
    // InvalidIdentifier (SYNC_TABLE_NAME_INVALID); no variant is ever accepted.
    // (Client Apply insert/update/delete runs the same matrix, behaviorally,
    // against a real sql.js DB in test/m6b2de4/identifier-apply-behavior.test.ts.)
    // ═══════════════════════════════════════════════════════════════════════

    #[derive(PartialEq, Debug)]
    enum Outcome {
        Forbidden,
        Invalid,
    }

    fn variants(name: &str) -> Vec<(String, Outcome)> {
        let mixed = {
            let mut c = name.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        };
        vec![
            (name.to_string(), Outcome::Forbidden), // the canonical forbidden name itself
            (name.to_uppercase(), Outcome::Invalid), // UPPERCASE
            (mixed, Outcome::Invalid),              // MixedCase
            (format!("main.{name}"), Outcome::Invalid), // schema-qualified
            (format!("temp.{name}"), Outcome::Invalid),
            (format!("\"{name}\""), Outcome::Invalid), // "quoted"
            (format!("`{name}`"), Outcome::Invalid),   // `quoted`
            (format!("[{name}]"), Outcome::Invalid),   // [quoted]
            (format!(" {name}"), Outcome::Invalid),    // leading whitespace
            (format!("{name} "), Outcome::Invalid),    // trailing whitespace
            (format!("{name}\n"), Outcome::Invalid),   // newline
            (format!("{name}\t"), Outcome::Invalid),   // tab
            (format!("{name};"), Outcome::Invalid),    // semicolon suffix
            (format!("{name}-- x"), Outcome::Invalid), // -- comment
            (format!("{name}/* x */"), Outcome::Invalid), // /* comment */
            (format!("{name}\u{0}"), Outcome::Invalid), // NUL
            (format!("{name}\u{7}"), Outcome::Invalid), // control char
            ("a".repeat(65), Outcome::Invalid),        // 65+ chars
        ]
    }

    const MATRIX_TABLES: &[&str] =
        &["enrolled_devices", "tenant_trust_roots", "root_custody", "users", "sync_cutover_state"];

    #[test]
    fn m_matrix_push_rejects_every_variant() {
        for table in MATRIX_TABLES {
            for (value, outcome) in variants(table) {
                let mut conn = db();
                let r = push(&mut conn, &[change_on(&value, "x", "update")]);
                match outcome {
                    Outcome::Forbidden => assert!(
                        matches!(r, Err(PushBatchError::ControlPlaneForbidden(_))),
                        "{table} / {value:?}: canonical forbidden name → ControlPlaneForbidden"
                    ),
                    Outcome::Invalid => {
                        assert!(
                            matches!(r, Err(PushBatchError::InvalidIdentifier(_))),
                            "{table} / {value:?}: non-canonical form → InvalidIdentifier"
                        );
                        // The denylist ALONE would miss it (not an exact name) — the charset gate
                        // is what catches it. That is the bypass, closed.
                        assert!(
                            !crate::sync::sync_policy::is_forbidden(&value),
                            "{value:?}: a non-canonical form is NOT an exact denylist hit"
                        );
                    }
                }
                assert_eq!(rows(&conn), 0, "{table} / {value:?}: no changelog row");
                assert!(r.is_err(), "{table} / {value:?}: no variant is ever accepted");
            }
        }
    }

    #[test]
    fn m_matrix_pull_withholds_every_variant() {
        for table in MATRIX_TABLES {
            for (value, outcome) in variants(table) {
                let scanned =
                    vec![pull_row(1, "products"), pull_row(2, &value), pull_row(3, "invoices")];
                let f = filter_forbidden_for_pull(scanned, 0);
                assert!(f.delivered.iter().all(|c| c.table_name != value), "{value:?}: withheld");
                assert_eq!(f.delivered.len(), 2, "{value:?}: the business rows still flow");
                assert_eq!(f.scanned_max, 3, "{value:?}: cursor advances past it");
                match outcome {
                    Outcome::Forbidden => assert_eq!(f.control_plane_filtered, 1, "{value:?}"),
                    Outcome::Invalid => assert_eq!(f.invalid_identifier_quarantined, 1, "{value:?}"),
                }
            }
        }
    }

    // ── §3 — a crafted table_name (control chars / newline / a megabyte) is refused, and its
    //    value is REDACTED: bounded, single-line, no punctuation leaks into a log line ──
    #[test]
    fn m_push_redacts_untrusted_table_names() {
        let attacks = [
            "products\n; DROP TABLE users; --".to_string(),
            "prod\tucts".to_string(),
            "products\u{0}".to_string(),
            "a".repeat(200_000),
        ];
        for value in attacks {
            let mut conn = db();
            let r = push(&mut conn, &[change_on(&value, "x", "update")]);
            assert!(matches!(r, Err(PushBatchError::InvalidIdentifier(_))), "{value:?}: refused");
            assert_eq!(rows(&conn), 0);
            let red = super::super::sync_policy::redact_identifier(&value);
            assert!(red.len() <= 40, "redaction is bounded ({} chars)", red.len());
            assert!(
                !red.contains('\n') && !red.contains('\t') && !red.contains('\u{0}'),
                "no control chars survive redaction"
            );
            assert!(!red.contains(';') && !red.contains('-'), "no SQL punctuation leaks");
        }
    }

    // ── §4 — a mixed changelog window: business, an invalid identifier, a control-plane row and
    //    another business row → only business delivered, cursor past BOTH filtered, counts split ──
    #[test]
    fn m_pull_mixed_window_delivers_only_business_with_split_diagnostics() {
        let scanned = vec![
            pull_row(10, "products"),
            pull_row(11, "DROP TABLE users"), // invalid identifier (spaces, uppercase)
            pull_row(12, "enrolled_devices"), // control-plane
            pull_row(13, "invoices"),
        ];
        let f = filter_forbidden_for_pull(scanned, 9);
        assert_eq!(f.delivered.len(), 2, "only the two business rows are delivered");
        assert!(f.delivered.iter().any(|c| c.table_name == "products"));
        assert!(f.delivered.iter().any(|c| c.table_name == "invoices"));
        assert!(f
            .delivered
            .iter()
            .all(|c| c.table_name != "enrolled_devices" && c.table_name != "DROP TABLE users"));
        assert_eq!(f.scanned_max, 13, "cursor past BOTH filtered rows — no head-of-line block");
        assert_eq!(f.control_plane_filtered, 1, "the enrolled_devices row");
        assert_eq!(f.invalid_identifier_quarantined, 1, "the 'DROP TABLE users' row");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // M6-B3A §6/§13 — the poisoned-changelog DoS, CLOSED at the push ingress.
    //
    // Under B2DE this exact push was ACCEPTED: `products` is a canonical, allowed table_name and the
    // server stored `data` opaquely, so the poison landed in the changelog, was delivered, and
    // choked every client on apply (the head-of-line DoS). B3A validates the payload against the
    // table contract BEFORE the write, so the poisoned push is now refused and NOTHING lands. This
    // is the test that flipped: it used to prove the server accepted it.
    // ═══════════════════════════════════════════════════════════════════════
    #[test]
    fn m6_server_now_rejects_a_payload_column_poisoned_push() {
        let mut conn = db();
        let poisoned = SyncPushChange {
            table_name: "products".into(), // canonical, allowed — passes BOTH the denylist and charset
            record_id: "p1".into(),
            action: "update".into(),
            data: "{\"BadColumn\": 1, \"another bad\": 2}".into(), // invalid column names in the payload
        };
        let r = push(&mut conn, &[poisoned]);
        assert!(
            matches!(
                r,
                Err(PushBatchError::SchemaViolation { code, .. })
                    if code == super::super::sync_schema::ERR_COLUMN_NAME_INVALID
            ),
            "§6: the payload-poisoned push is REFUSED (SYNC_COLUMN_NAME_INVALID), not accepted — got {r:?}"
        );
        assert_eq!(
            rows(&conn),
            0,
            "§6/§13: nothing lands in the changelog — no poison to detonate on any client later"
        );

        // A canonical-but-UNKNOWN column (not in the products contract) is refused too, as
        // SYNC_FIELD_NOT_ALLOWED (distinct from the non-canonical case above).
        let mut conn2 = db();
        let field_poison = SyncPushChange {
            table_name: "products".into(),
            record_id: "p2".into(),
            action: "update".into(),
            data: "{\"bad_column\": 1}".into(),
        };
        let r2 = push(&mut conn2, &[field_poison]);
        assert!(
            matches!(
                r2,
                Err(PushBatchError::SchemaViolation { code, .. })
                    if code == super::super::sync_schema::ERR_FIELD_NOT_ALLOWED
            ),
            "§5: a canonical-but-unknown column is SYNC_FIELD_NOT_ALLOWED — got {r2:?}"
        );
        assert_eq!(rows(&conn2), 0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // M6-B2DE4 §7 — the legacy-activity FAILURE contract.
    // ═══════════════════════════════════════════════════════════════════════

    // ── an invalid-identifier push after attestation does NOT mark activity ──
    #[test]
    fn rejected_invalid_identifier_push_does_not_count_as_activity() {
        let mut conn = db_with_attestation();
        let r = push(&mut conn, &[change_on("BAD TABLE", "x", "update")]);
        assert!(matches!(r, Err(PushBatchError::InvalidIdentifier(_))));
        assert_eq!(rows(&conn), 0);
        let (flag, state) = cutover_flags(&conn);
        assert_eq!(flag, 0, "§7: a refused push is not activity — readiness stands");
        assert_eq!(state, "ready_for_protocol_activation");
    }

    // ── a successful pull records the activity marking ──
    #[test]
    fn successful_pull_records_activity_marking() {
        let mut conn = db_with_attestation();
        record_pull_activity(&mut conn, "tenant-1", "branch-main", "2026-07-17").unwrap();
        let (flag, state) = cutover_flags(&conn);
        assert_eq!(flag, 1, "§7: a successful pull marks legacy activity");
        assert_eq!(state, "activation_blocked");
    }

    // ── a failure to persist the pull marking is a HARD error (no successful response) ──
    #[test]
    fn pull_activity_persist_failure_is_a_hard_error() {
        let mut conn = db_with_attestation();
        conn.execute_batch(
            "CREATE TRIGGER boom_cutover BEFORE UPDATE ON sync_cutover_state
             BEGIN SELECT RAISE(ABORT, 'controlled cutover failure'); END;",
        )
        .unwrap();
        let r = record_pull_activity(&mut conn, "tenant-1", "branch-main", "2026-07-17");
        assert!(r.is_err(), "§7: a failed marking must be a hard error → sync_pull returns 500, no success");
        let (flag, _) = cutover_flags(&conn);
        assert_eq!(flag, 0, "the marking did not commit");
    }

    // ── Inactivity: the legacy path must not touch the new protocol columns ─
    #[test]
    fn legacy_push_writes_no_protocol_fields() {
        let mut conn = db();
        conn.execute_batch(
            "ALTER TABLE sync_changelog ADD COLUMN record_revision INTEGER;
             ALTER TABLE sync_changelog ADD COLUMN operation_id TEXT;
             ALTER TABLE sync_changelog ADD COLUMN protocol_version INTEGER;",
        )
        .unwrap();
        push(&mut conn, &[change("p1")]).unwrap();
        let (rev, op, pv): (Option<i64>, Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT record_revision, operation_id, protocol_version FROM sync_changelog WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert!(rev.is_none() && op.is_none() && pv.is_none(), "legacy path stays legacy");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // M6-B3A §12 — Q1–Q16: the schema-allowlist + pull-quarantine contract.
    // ═══════════════════════════════════════════════════════════════════════

    // A `db()` plus the real v0009 quarantine table (from the migration SQL, not a hand copy).
    fn db_q() -> Connection {
        let conn = db();
        conn.execute_batch(crate::sync::migrations::V0009_SYNC_SCHEMA_AND_QUARANTINE.up_sql).unwrap();
        conn
    }
    fn pull_full(id: i64, table: &str, record: &str, action: &str, data: &str) -> SyncChange {
        SyncChange {
            id,
            table_name: table.into(),
            record_id: record.into(),
            branch_id: "branch-main".into(),
            action: action.into(),
            data: data.into(),
            created_at: "n".into(),
        }
    }
    fn pull_d(id: i64, table: &str, action: &str, data: &str) -> SyncChange {
        pull_full(id, table, &format!("r{id}"), action, data)
    }
    fn pchg(table: &str, record: &str, action: &str, data: &str) -> SyncPushChange {
        SyncPushChange { table_name: table.into(), record_id: record.into(), action: action.into(), data: data.into() }
    }
    fn open_quarantine(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM sync_change_quarantine WHERE state='open'", [], |r| r.get(0)).unwrap()
    }

    // ── Q1–Q8: server ingress (push) ─────────────────────────────────────────
    #[test]
    fn q1_valid_table_and_allowed_fields_accepted() {
        let mut conn = db();
        let n = push(&mut conn, &[pchg("products", "p1", "insert", r#"{"id":"p1","brand":"Rolex","name":"Sub"}"#)]).unwrap();
        assert_eq!(n, 1);
        assert_eq!(rows(&conn), 1);
    }

    #[test]
    fn q2_unknown_table_rejects_whole_batch() {
        let mut conn = db();
        let r = push(&mut conn, &[change("ok1"), change_on("some_unknown_table", "x", "update"), change("ok2")]);
        assert!(matches!(r, Err(PushBatchError::TableNotAllowed(_))), "got {r:?}");
        assert_eq!(rows(&conn), 0, "no partial acceptance");
    }

    #[test]
    fn q3_forbidden_table_rejects_whole_batch() {
        let mut conn = db();
        let r = push(&mut conn, &[change("ok1"), change_on("users", "x", "update")]);
        assert!(matches!(r, Err(PushBatchError::ControlPlaneForbidden(_))), "got {r:?}");
        assert_eq!(rows(&conn), 0);
    }

    #[test]
    fn q4_valid_table_unknown_field_rejected() {
        let mut conn = db();
        let r = push(&mut conn, &[pchg("products", "p1", "update", r#"{"bad_field":1}"#)]);
        assert!(
            matches!(r, Err(PushBatchError::SchemaViolation { code, .. }) if code == super::super::sync_schema::ERR_FIELD_NOT_ALLOWED),
            "got {r:?}"
        );
        assert_eq!(rows(&conn), 0);
    }

    #[test]
    fn q5_invalid_field_identifier_rejected() {
        let mut conn = db();
        let r = push(&mut conn, &[pchg("products", "p1", "update", r#"{"Bad Field":1}"#)]);
        assert!(
            matches!(r, Err(PushBatchError::SchemaViolation { code, .. }) if code == super::super::sync_schema::ERR_COLUMN_NAME_INVALID),
            "got {r:?}"
        );
        assert_eq!(rows(&conn), 0);
    }

    #[test]
    fn q6_invalid_payload_form_rejected() {
        for bad in [r#"[1,2,3]"#, r#""a string""#, "not json at all"] {
            let mut conn = db();
            let r = push(&mut conn, &[pchg("products", "p1", "update", bad)]);
            assert!(
                matches!(r, Err(PushBatchError::SchemaViolation { code, .. }) if code == super::super::sync_schema::ERR_PAYLOAD_INVALID),
                "{bad:?}: got {r:?}"
            );
            assert_eq!(rows(&conn), 0, "{bad:?}");
        }
    }

    #[test]
    fn q7_mixed_valid_invalid_batch_writes_nothing() {
        let mut conn = db();
        let r = push(&mut conn, &[change("ok1"), pchg("products", "p2", "update", r#"{"bad_field":1}"#), change("ok2")]);
        assert!(r.is_err());
        assert_eq!(rows(&conn), 0, "the surrounding valid rows do not survive — all-or-nothing");
    }

    #[test]
    fn q8_rejected_batch_is_not_legacy_activity() {
        let mut conn = db_with_attestation();
        let r = push(&mut conn, &[pchg("products", "p1", "update", r#"{"bad_field":1}"#)]);
        assert!(matches!(r, Err(PushBatchError::SchemaViolation { .. })));
        assert_eq!(rows(&conn), 0);
        let (flag, state) = cutover_flags(&conn);
        assert_eq!(flag, 0, "a refused push is not activity — readiness stands");
        assert_eq!(state, "ready_for_protocol_activation");
    }

    // ── Q9–Q16: server pull quarantine ───────────────────────────────────────
    #[test]
    fn q9_to_q13_pull_delivers_valid_quarantines_invalid_and_advances() {
        let mut conn = db_q();
        let scanned = vec![
            pull_d(1, "products", "update", r#"{"id":"r1","brand":"Rolex"}"#), // valid
            pull_d(2, "products", "update", r#"{"bad_field":1}"#),              // poison field
            pull_d(3, "some_unknown_table", "update", "{}"),                    // unknown table
            pull_d(4, "enrolled_devices", "update", "{}"),                      // control-plane
            pull_d(5, "invoices", "update", r#"{"id":"r5"}"#),                  // valid
        ];
        let f = filter_forbidden_for_pull(scanned, 0);
        // Q9 — only valid business rows delivered
        assert_eq!(f.delivered.len(), 2);
        assert!(f.delivered.iter().all(|c| c.table_name == "products" || c.table_name == "invoices"));
        // Q10 — every invalid DATA row quarantined; Q11 — control-plane only filtered (not quarantined)
        assert_eq!(f.invalid_field_quarantined, 1);
        assert_eq!(f.unknown_table_quarantined, 1);
        assert_eq!(f.control_plane_filtered, 1);
        assert_eq!(f.to_quarantine.len(), 2);
        // Q12 — cursor over ALL scanned ids (incl. withheld); Q13 — no head-of-line block
        assert_eq!(f.scanned_max, 5);
        persist_pull_quarantine(&mut conn, "tenant-1", "branch-main", "2026-07-18", &f.to_quarantine).unwrap();
        assert_eq!(open_quarantine(&conn), 2);
    }

    #[test]
    fn q14_identical_repull_does_not_duplicate_quarantine() {
        let mut conn = db_q();
        let mk = || vec![pull_d(2, "products", "update", r#"{"bad_field":1}"#)];
        persist_pull_quarantine(&mut conn, "tenant-1", "branch-main", "t1", &filter_forbidden_for_pull(mk(), 0).to_quarantine).unwrap();
        persist_pull_quarantine(&mut conn, "tenant-1", "branch-main", "t2", &filter_forbidden_for_pull(mk(), 0).to_quarantine).unwrap();
        let (cnt, occ): (i64, i64) = conn
            .query_row("SELECT COUNT(*), MAX(occurrence_count) FROM sync_change_quarantine", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(cnt, 1, "one row, deduped by change_id");
        assert_eq!(occ, 2, "occurrence_count bumped on re-pull, not a duplicate");
    }

    #[test]
    fn q15_quarantine_persist_failure_is_a_hard_error() {
        let mut conn = db_q();
        conn.execute_batch("DROP TABLE sync_change_quarantine").unwrap();
        let f = filter_forbidden_for_pull(vec![pull_d(2, "products", "update", r#"{"bad_field":1}"#)], 0);
        assert!(!f.to_quarantine.is_empty());
        // Persist fails → Err → sync_pull returns 500 → the client cursor never advances past it.
        assert!(persist_pull_quarantine(&mut conn, "tenant-1", "branch-main", "t", &f.to_quarantine).is_err());
    }

    #[test]
    fn q16_quarantine_stores_no_raw_secrets() {
        let mut conn = db_q();
        let secret_record = "super-secret-record-id-1234";
        let secret_payload = r#"{"password_hash":"TOPSECRET-HASH","bad_field":"leak-me-please"}"#;
        let scanned = vec![pull_full(2, "products", secret_record, "update", secret_payload)];
        let f = filter_forbidden_for_pull(scanned, 0);
        persist_pull_quarantine(&mut conn, "tenant-1", "branch-main", "t", &f.to_quarantine).unwrap();
        let (tbl, rec, pay): (String, String, String) = conn
            .query_row(
                "SELECT table_name_redacted, record_id_hash, payload_hash FROM sync_change_quarantine",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert!(!rec.contains("super-secret"), "record id is hashed, not raw");
        assert!(!pay.contains("TOPSECRET") && !pay.contains("leak-me"), "payload is hashed, not raw");
        assert!(rec.len() <= 8 && pay.len() <= 8, "hashes are bounded 8-hex");
        assert_eq!(tbl, "products<len=8>", "table name is redacted with its length");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // M6-B3A1 §3/§4 — the per-table operation matrix (O1–O10).
    // ═══════════════════════════════════════════════════════════════════════

    // O1/O2/O3/O4/O5/O10 — table-driven over the WHOLE manifest: every allowed op is accepted, every
    // disallowed op is SYNC_OPERATION_NOT_ALLOWED (never silently reinterpreted), and the exact
    // insert/update/delete table counts are asserted (49/36/37 — proving the matrix is not uniform).
    #[test]
    fn o1_o5_o10_operation_matrix_enforced_for_every_table() {
        let schema = super::super::sync_schema::schema();
        let (mut ins, mut upd, mut del) = (0usize, 0usize, 0usize);
        for (table, contract) in &schema.tables {
            for op in ["insert", "update", "delete"] {
                let mut conn = db();
                let data = if op == "delete" { "{}" } else { r#"{"id":"x"}"# };
                let r = push(&mut conn, &[pchg(table, "x", op, data)]);
                if contract.ops.contains(op) {
                    assert!(r.is_ok(), "{table}/{op}: an allowed operation must be accepted, got {r:?}");
                    assert_eq!(rows(&conn), 1, "{table}/{op}");
                } else {
                    assert!(
                        matches!(&r, Err(PushBatchError::SchemaViolation { code, .. }) if *code == super::super::sync_schema::ERR_OPERATION_NOT_ALLOWED),
                        "{table}/{op}: a disallowed operation must be SYNC_OPERATION_NOT_ALLOWED, got {r:?}"
                    );
                    assert_eq!(rows(&conn), 0, "{table}/{op}: no changelog row — O10, never silently reinterpreted");
                }
            }
            if contract.ops.contains("insert") { ins += 1; }
            if contract.ops.contains("update") { upd += 1; }
            if contract.ops.contains("delete") { del += 1; }
        }
        assert_eq!((ins, upd, del), (50, 36, 37), "insert/update/delete table counts (O1: some tables have all 3; O4: e.g. purchase_inbox has no delete)");
    }

    // O6 — a mixed batch with one disallowed operation writes NOTHING (all-or-nothing).
    #[test]
    fn o6_mixed_valid_and_disallowed_operation_writes_nothing() {
        let mut conn = db();
        let r = push(
            &mut conn,
            &[
                pchg("products", "p1", "insert", r#"{"id":"p1"}"#),
                pchg("purchase_inbox", "pi1", "delete", "{}"), // purchase_inbox has no delete → not allowed
                pchg("invoices", "i1", "update", r#"{"id":"i1"}"#),
            ],
        );
        assert!(
            matches!(&r, Err(PushBatchError::SchemaViolation { code, .. }) if *code == super::super::sync_schema::ERR_OPERATION_NOT_ALLOWED),
            "got {r:?}"
        );
        assert_eq!(rows(&conn), 0, "the surrounding valid changes do not survive");
    }

    // O7/O9 — a HISTORICAL disallowed-operation changelog row is quarantined on pull (with the
    // operation code) and the cursor still advances past it.
    #[test]
    fn o7_o9_historical_disallowed_operation_is_quarantined_and_cursor_advances() {
        let mut conn = db_q();
        let scanned = vec![
            pull_d(1, "products", "update", r#"{"id":"r1"}"#),        // valid
            pull_d(2, "purchase_inbox", "delete", "{}"),             // disallowed op (purchase_inbox has no delete)
            pull_d(3, "invoices", "update", r#"{"id":"r3"}"#),        // valid
        ];
        let f = filter_forbidden_for_pull(scanned, 0);
        assert_eq!(f.delivered.len(), 2, "O7: the disallowed-op row is withheld");
        assert_eq!(f.to_quarantine.len(), 1);
        assert_eq!(
            f.to_quarantine[0].reason_code,
            super::super::sync_schema::ERR_OPERATION_NOT_ALLOWED,
            "O7: quarantined with the operation code"
        );
        assert_eq!(f.scanned_max, 3, "O9: cursor advances past the quarantined row");
        persist_pull_quarantine(&mut conn, "tenant-1", "branch-main", "t", &f.to_quarantine).unwrap();
        assert_eq!(open_quarantine(&conn), 1);
    }

    // ── M6-B3A1 §6 — the inner `data` payload's duplicate keys are refused (SYNC_PAYLOAD_DUPLICATE_KEY)
    //    at push; none bypasses the field/operation allowlist. (Envelope duplicates are proven in
    //    sync_schema::dup_scanner_detects_duplicates_at_every_object_level and rejected by sync_push.)
    #[test]
    fn dup_data_payload_keys_rejected_by_push() {
        for data in [r#"{"brand":"a","brand":"b"}"#, r#"{"bad_col":"a","bad_col":"b"}"#, r#"{"id":"a","id":"b"}"#] {
            let mut conn = db();
            let r = push(&mut conn, &[pchg("products", "p1", "update", data)]);
            assert!(
                matches!(&r, Err(PushBatchError::SchemaViolation { code, .. }) if *code == super::super::sync_schema::ERR_PAYLOAD_DUPLICATE_KEY),
                "{data}: got {r:?}"
            );
            assert_eq!(rows(&conn), 0, "{data}: no changelog row for a duplicate-key payload");
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // M6-B3A2 §5 — released-legacy (v0.8.23) payload compatibility.
    // ═══════════════════════════════════════════════════════════════════════

    // The EXACT payloads the v0.8.23 mobile picture uploader sends (mobile_page.rs, byte-identical at
    // tag v0.8.23 = 114cc64) MUST all be accepted by the current embedded server — no quarantine, no
    // operation/field false-rejection. Notably the purchase_inbox INSERT the desktop never emits.
    #[test]
    fn legacy_compat_v0823_mobile_fixtures_are_accepted() {
        let mobile: &[(&str, &str, &str)] = &[
            ("products", "insert", r#"{"id":"p1","branch_id":"b","category_id":"cat-watch","brand":"Rolex","name":"Sub","sku":null,"quantity":1,"condition":"","scope_of_delivery":"[]","purchase_date":"2026-07-18","purchase_price":100,"purchase_currency":"BHD","planned_sale_price":null,"stock_status":"in_stock","tax_scheme":"MARGIN","source_type":"OWN","notes":null,"images":"[]","image_hash":null,"attributes":"{}","created_at":"t","updated_at":"t","created_by":null}"#),
            ("customers", "insert", r#"{"id":"c1","branch_id":"b","first_name":"A","last_name":"B","created_at":"t","updated_at":"t"}"#),
            ("repairs", "insert", r#"{"id":"r1","branch_id":"b","repair_number":"REP","voucher_code":"ABCD1234","customer_id":"c1","item_brand":"X","item_model":"Y","issue_description":"broken","repair_type":"internal","status":"received","received_at":"t","images":"[]","notes":null,"created_at":"t","updated_at":"t","created_by":null}"#),
            ("purchase_inbox", "insert", r#"{"id":"pi1","branch_id":"b","images":"[]","note":null,"status":"pending","created_at":"t","created_by":null}"#),
        ];
        for (t, op, data) in mobile {
            let mut conn = db();
            let n = push(&mut conn, &[pchg(t, "x", op, data)])
                .unwrap_or_else(|e| panic!("v0.8.23 mobile {t}/{op} MUST be accepted, got {e:?}"));
            assert_eq!(n, 1, "{t}/{op}");
            assert_eq!(rows(&conn), 1, "{t}/{op}");
        }
        // representative non-uniform desktop cases (insert-only ledger, insert+delete invoice_lines).
        let desktop: &[(&str, &str, &str)] = &[
            ("ledger_entries", "insert", r#"{"id":"l1","account":"CASH","amount":"5"}"#),
            ("invoice_lines", "insert", r#"{"id":"il1","invoice_id":"i1"}"#),
            ("invoice_lines", "delete", "{}"),
        ];
        for (t, op, data) in desktop {
            let mut conn = db();
            assert!(push(&mut conn, &[pchg(t, "x", op, data)]).is_ok(), "{t}/{op} must be accepted");
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // M6-B3A2 §9/§10/§11 — the raw-body route contract.
    // ═══════════════════════════════════════════════════════════════════════

    // §9 — the 50 MB body limit is configured AND applied to the router (unchanged by the Bytes
    // switch). Derived from the max legit batch: pushChanges LIMITs 100 changes and a mobile photo
    // (1600px @ 0.85) is ~0.5 MB base64 → ~50 MB worst case. axum's DefaultBodyLimit returns 413
    // BEFORE the handler buffers the body, so an oversized body triggers no JSON parse, no DB write,
    // no quarantine and no legacy-activity mark.
    #[test]
    fn raw_body_50mb_limit_configured_and_applied() {
        // §3 — the production limit is the constant, applied via build_api_router; mod.rs passes the
        // constant (never a smaller literal). The BEHAVIOURAL boundary proof is the runtime
        // integration test `raw_push_runtime::body_limit_boundary`.
        assert_eq!(MAX_SYNC_PUSH_BODY_BYTES, 50 * 1024 * 1024, "the production limit is 50 MB");
        let r = include_str!("routes.rs");
        let prod = &r[..r.find("#[cfg(test)]").unwrap_or(r.len())];
        assert!(prod.contains("DefaultBodyLimit::max(body_limit)"), "build_api_router applies the parametrized limit");
        let m = include_str!("mod.rs");
        assert!(
            m.contains("build_api_router(state.clone(), routes::MAX_SYNC_PUSH_BODY_BYTES)"),
            "production builds the router with the 50 MB constant"
        );
    }

    // §11 — gate order. `sync_push` takes the raw Bytes body; the write gate runs first, THEN the
    // duplicate scan, THEN the parse, THEN the DB apply. Auth is a route_layer on the protected
    // routes, so it runs before every protected handler. Therefore no unauthenticated request reaches
    // the expensive dup scan, a changelog write, a quarantine write or an activity mark.
    #[test]
    fn raw_body_gate_order_auth_before_dup_scan_and_db() {
        let src = include_str!("routes.rs");
        let prod = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
        assert!(prod.contains("body: axum::body::Bytes"), "sync_push takes the raw Bytes body");
        let push_at = prod.find("async fn sync_push").expect("sync_push");
        let body = &prod[push_at..];
        let gate = body.find("may_write_sync()").expect("primary gate");
        let dup = body.find("contains_duplicate_json_key").expect("dup scan");
        let parse = body.find("SyncPushRequest = serde_json::from_str").expect("parse");
        let apply = body.find("apply_legacy_push_batch").expect("apply");
        assert!(gate < dup, "the primary/write gate precedes the duplicate scan");
        assert!(dup < parse && parse < apply, "dup scan + parse precede the DB apply");
        // auth composition: a route_layer over the protected routes (incl. /sync/push).
        assert!(prod.contains("route_layer(middleware::from_fn_with_state"), "auth is a route_layer");
        assert!(prod.contains(".route(\"/sync/push\", post(sync_push))"), "/sync/push is protected");
    }

    // §10 — the parse contract the Bytes handler enforces, tested on the EXACT calls sync_push makes
    // (`str::from_utf8` then `serde_json::from_str::<SyncPushRequest>`): valid → Ok; empty / malformed
    // / wrong-structure / trailing-garbage → Err (→ 400); non-UTF-8 bytes rejected before JSON.
    #[test]
    fn raw_body_parse_contract() {
        assert!(serde_json::from_str::<SyncPushRequest>(r#"{"changes":[]}"#).is_ok());
        assert!(serde_json::from_str::<SyncPushRequest>(
            r#"{"changes":[{"table_name":"products","record_id":"p","action":"insert","data":"{}"}]}"#
        ).is_ok());
        for bad in [
            "",                       // empty
            "   ",                    // whitespace only
            "not json at all",       // malformed
            "{",                      // truncated
            r#"{"foo":1}"#,          // wrong structure (no `changes`)
            r#"{"changes":{}}"#,     // wrong type for `changes`
            r#"{"changes":[]}x"#,    // trailing garbage
            r#"{"changes":[]} {"a":1}"#, // two values
        ] {
            assert!(serde_json::from_str::<SyncPushRequest>(bad).is_err(), "must be a 400: {bad:?}");
        }
        // A non-UTF-8 body is rejected by the handler's `str::from_utf8` BEFORE any JSON handling —
        // arbitrary binary is never treated as JSON. Built at runtime so the check is not const-folded.
        let non_utf8: Vec<u8> = (0u8..4).map(|i| [0xff, 0xfe, 0x00, 0x01][i as usize]).collect();
        assert!(std::str::from_utf8(&non_utf8).is_err());
    }

    // ═══════════════════════════════════════════════════════════════════════
    // M6-B3A3 §2/§4/§5 + M6-B3A4 §3–§10 — RUNTIME integration proof: drive the ACTUAL production route.
    //
    // No rebuilt handler, no direct sync_push() call, no source-scan-as-proof. Every request goes
    // through `build_api_router` — the SAME function `SyncServer::start` runs in production — via
    // `tower::oneshot`: real /api/sync/push route, real auth middleware, real primary/write gate,
    // real DefaultBodyLimit, real AppState + test DB. Only the body-limit VALUE differs (a small
    // limit so the exact boundary is proven without a 50 MB allocation); the router construction and
    // layer order are identical to production.
    //
    // B3A3 proved the body-limit boundary and basic auth/primary order. B3A4 completes the raw-route
    // contract on the SAME real router: the JSON content-type matrix (C1–C6), the full JSON route
    // matrix (J1–J11), the full auth matrix (A1–A5), the primary/write-gate matrix (P1–P3), a
    // table-driven DB non-mutation proof over every rejection class, a full successful desktop push
    // with the legacy-activity contract, and the released mobile fixtures end-to-end. B3A5 hardens the
    // non-mutation proof to the FULL cutover state (state / activity flag / timestamp / attestation id),
    // runs the whole negative matrix against an ARMED cutover row to prove no rejected request ever sets
    // state=activation_blocked, and adds the positive attestation contract (a valid push DOES block it).
    // ═══════════════════════════════════════════════════════════════════════
    mod runtime {
        use super::db_q;
        use crate::sync::{auth, primary, routes, AppState};
        use axum::body::Body;
        use axum::http::Request;
        use std::sync::Arc;
        use tokio::sync::Mutex;
        use tower::util::ServiceExt; // Router::oneshot

        const SECRET: &str = "runtime-integration-secret";
        const MAX: usize = routes::MAX_SYNC_PUSH_BODY_BYTES;

        fn state(primary: primary::State) -> Arc<AppState> {
            Arc::new(AppState {
                db: Mutex::new(db_q()), // sync_changelog + sync_cutover_state + sync_change_quarantine
                jwt_secret: SECRET.to_string(),
                frontend_db_path: std::path::PathBuf::from("runtime-test-frontend.db"),
                primary_state: primary,
            })
        }
        // Replicate the PRODUCTION composition: build_api_router nested under /api (as SyncServer::start
        // does), so requests hit the real `/api/sync/push` path with the real layer order. Only the
        // body-limit value differs from production; the router construction is identical.
        fn router(state: Arc<AppState>, body_limit: usize) -> axum::Router {
            axum::Router::new()
                .nest("/api", routes::build_api_router(state.clone(), body_limit))
                .with_state(state)
        }
        fn token() -> String {
            auth::create_token("u", "tenant-1", "branch-main", "owner", SECRET).unwrap()
        }
        fn req(token: Option<&str>, content_type: Option<&str>, body: Vec<u8>) -> Request<Body> {
            let mut b = Request::builder().method("POST").uri("/api/sync/push");
            if let Some(t) = token {
                b = b.header("authorization", format!("Bearer {t}"));
            }
            if let Some(c) = content_type {
                b = b.header("content-type", c);
            }
            b.body(Body::from(body)).unwrap()
        }
        // A VALID products-insert push padded to EXACTLY `target` bytes (`notes` is a real column, so
        // padding it keeps the payload legitimate → the handler accepts an under/at-limit body).
        fn valid_push_of_size(target: usize) -> Vec<u8> {
            let prefix = r#"{"changes":[{"table_name":"products","record_id":"p1","action":"insert","data":"{\"id\":\"p1\",\"branch_id\":\"b\",\"category_id\":\"c\",\"brand\":\"X\",\"name\":\"Y\",\"purchase_price\":1,\"notes\":\""#;
            let suffix = r#"\"}"}]}"#;
            let overhead = prefix.len() + suffix.len();
            let pad = target.saturating_sub(overhead);
            format!("{prefix}{}{suffix}", "a".repeat(pad)).into_bytes()
        }
        async fn count(state: &Arc<AppState>, table: &str) -> i64 {
            let db = state.db.lock().await;
            db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap()
        }
        async fn activity_marks(state: &Arc<AppState>) -> i64 {
            let db = state.db.lock().await;
            db.query_row(
                "SELECT COUNT(*) FROM sync_cutover_state WHERE legacy_activity_after_attestation = 1",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0)
        }
        // §7/§8 — an AppState whose cutover row is ARMED (owner has attested): state
        // `ready_for_protocol_activation`, `current_attestation_id` set. `record_legacy_activity` is live
        // here, so a SUCCESSFUL push through the router invalidates readiness in the same transaction
        // (state → activation_blocked, flag → 1) — and a REJECTED push must leave ALL of it untouched, a
        // real proof the apply path was never entered. `primary` lets B3A5 build an armed READ-ONLY
        // server too, so the write-gate 403 path runs over the same armed row. Same quarantine table as
        // `state()`.
        fn armed_with(primary: primary::State) -> Arc<AppState> {
            let conn = super::db_with_attestation();
            conn.execute_batch(crate::sync::migrations::V0009_SYNC_SCHEMA_AND_QUARANTINE.up_sql)
                .unwrap();
            Arc::new(AppState {
                db: Mutex::new(conn),
                jwt_secret: SECRET.to_string(),
                frontend_db_path: std::path::PathBuf::from("runtime-test-frontend.db"),
                primary_state: primary,
            })
        }
        fn armed_state() -> Arc<AppState> {
            armed_with(primary::State::Primary)
        }
        // §2/§7 (B3A5) — the FULL cutover-state snapshot for a before==after non-mutation proof: the
        // changelog + quarantine counts, PLUS the exact sync_cutover_state row for the token's
        // tenant/branch — `state`, the `legacy_activity_after_attestation` flag, the
        // `last_legacy_activity_at` timestamp, and `current_attestation_id`. `cutover` is `None` when no
        // cutover row exists (a bare db_q). A rejected router request must leave ALL of this byte-
        // identical; in particular it must NEVER flip `state` to `activation_blocked`.
        #[derive(Debug, PartialEq, Clone)]
        struct Snapshot {
            changelog: i64,
            quarantine: i64,
            // (state, legacy_activity_after_attestation, last_legacy_activity_at, current_attestation_id)
            cutover: Option<(String, i64, Option<String>, Option<String>)>,
        }
        async fn snapshot(state: &Arc<AppState>) -> Snapshot {
            use rusqlite::OptionalExtension;
            let db = state.db.lock().await;
            let changelog: i64 =
                db.query_row("SELECT COUNT(*) FROM sync_changelog", [], |r| r.get(0)).unwrap();
            let quarantine: i64 = db
                .query_row("SELECT COUNT(*) FROM sync_change_quarantine", [], |r| r.get(0))
                .unwrap();
            let cutover = db
                .query_row(
                    "SELECT state, legacy_activity_after_attestation, last_legacy_activity_at, \
                     current_attestation_id FROM sync_cutover_state \
                     WHERE tenant_id='tenant-1' AND branch_id='branch-main'",
                    [],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, i64>(1)?,
                            r.get::<_, Option<String>>(2)?,
                            r.get::<_, Option<String>>(3)?,
                        ))
                    },
                )
                .optional()
                .unwrap();
            Snapshot { changelog, quarantine, cutover }
        }
        // A products-insert push whose ENVELOPE is well-formed but whose inner `data` string carries a
        // DUPLICATE key (`id` twice). The envelope dup scanner does not see keys inside a string value,
        // so this is refused only by per-change payload validation → SYNC_PAYLOAD_DUPLICATE_KEY → 400.
        fn inner_dup_body() -> Vec<u8> {
            br#"{"changes":[{"table_name":"products","record_id":"p1","action":"insert","data":"{\"id\":\"p1\",\"id\":\"p2\"}"}]}"#.to_vec()
        }
        // An ENVELOPE-level duplicate key (`action` twice), refused by the raw dup scanner → 400.
        fn envelope_dup_body() -> Vec<u8> {
            br#"{"changes":[{"table_name":"products","record_id":"p1","action":"insert","action":"update","data":"{}"}]}"#.to_vec()
        }

        // §4 — R1 under / R2 exactly-at / R3 one-byte-over, through the REAL router with a 1024-byte
        // limit. R3 is 413 with NO side effect (no changelog, no quarantine, no activity mark).
        #[tokio::test]
        async fn body_limit_boundary() {
            const LIMIT: usize = 1024;

            // R1 — just under the limit → accepted.
            let s1 = state(primary::State::Primary);
            let r1 = router(s1.clone(), LIMIT)
                .oneshot(req(Some(&token()), Some("application/json"), valid_push_of_size(LIMIT - 1)))
                .await
                .unwrap();
            assert_eq!(r1.status().as_u16(), 200, "R1 under-limit valid push is accepted");
            assert_eq!(count(&s1, "sync_changelog").await, 1, "R1 wrote exactly one changelog row");

            // R2 — exactly at the limit → accepted (DefaultBodyLimit rejects only when EXCEEDED).
            let s2 = state(primary::State::Primary);
            let r2 = router(s2.clone(), LIMIT)
                .oneshot(req(Some(&token()), Some("application/json"), valid_push_of_size(LIMIT)))
                .await
                .unwrap();
            assert_eq!(r2.status().as_u16(), 200, "R2 exactly-at-limit valid push is accepted");
            assert_eq!(count(&s2, "sync_changelog").await, 1);

            // R3 — one byte over → 413, and NOTHING happened server-side.
            let s3 = state(primary::State::Primary);
            let r3 = router(s3.clone(), LIMIT)
                .oneshot(req(Some(&token()), Some("application/json"), valid_push_of_size(LIMIT + 1)))
                .await
                .unwrap();
            assert_eq!(r3.status().as_u16(), 413, "R3 over-limit → 413 Payload Too Large");
            assert_eq!(count(&s3, "sync_changelog").await, 0, "R3: no changelog row (handler never ran)");
            assert_eq!(count(&s3, "sync_change_quarantine").await, 0, "R3: no quarantine row");
            assert_eq!(activity_marks(&s3).await, 0, "R3: no legacy-activity mark, no partial transaction");
        }

        // §4 note — axum's DefaultBodyLimit enforces the limit on the STREAMED bytes as the body is
        // read (http_body_util::Limited), NOT on a Content-Length pre-check. Proof: a body whose
        // declared length is small but whose actual stream exceeds the limit is still rejected. So
        // the boundary test above already exercises during-read enforcement; there is no separate
        // "Content-Length says OK but stream overflows" bypass to guard.
        #[tokio::test]
        async fn body_limit_enforced_during_read_not_by_content_length() {
            const LIMIT: usize = 64;
            let s = state(primary::State::Primary);
            // 200 bytes of body → far over the 64-byte limit → 413 while reading.
            let r = router(s.clone(), LIMIT)
                .oneshot(req(Some(&token()), Some("application/json"), vec![b'a'; 200]))
                .await
                .unwrap();
            assert_eq!(r.status().as_u16(), 413, "an over-limit body is rejected as it streams in");
            assert_eq!(count(&s, "sync_changelog").await, 0);
        }

        // §5 — the auth matrix through the REAL router. EVERY unauthenticated or bad-token variant is
        // 401 at the auth route_layer, BEFORE the handler, the body extractor (body limit) and the dup
        // scanner. So no unauthenticated request can write a changelog row, quarantine anything, mark
        // legacy activity, or even make the server buffer/scan its body. The A2 and A4 assertions carry
        // the sharp edges: A2 is 401 NOT 400 (a 400 would mean the dup scanner ran, i.e. the handler was
        // reached); A4 is 401 NOT 413 (auth precedes body extraction, so the oversized body is never
        // buffered — stronger than a 413 after buffering).
        #[tokio::test]
        async fn auth_matrix() {
            let cases: &[(&str, Option<&str>, Vec<u8>, usize)] = &[
                ("A1 valid body, no auth", None, valid_push_of_size(300), MAX),
                ("A2 dup-key body, no auth", None, envelope_dup_body(), MAX),
                ("A3 large under-limit, no auth", None, valid_push_of_size(900), 1024),
                ("A4 over-limit body, no auth", None, vec![b'a'; 4096], 1024),
                ("A5 invalid token", Some("not.a.valid.jwt"), valid_push_of_size(300), MAX),
            ];
            for (label, tok, body, limit) in cases {
                let s = state(primary::State::Primary);
                let before = snapshot(&s).await;
                let r = router(s.clone(), *limit)
                    .oneshot(req(*tok, Some("application/json"), body.clone()))
                    .await
                    .unwrap();
                assert_eq!(r.status().as_u16(), 401, "{label} → 401 at the auth layer");
                assert_ne!(r.status().as_u16(), 400, "{label}: dup scanner NOT reached");
                assert_ne!(r.status().as_u16(), 413, "{label}: body NOT buffered (auth precedes body limit)");
                assert_eq!(snapshot(&s).await, before, "{label}: DB untouched (no write/quarantine/mark)");
            }
        }

        // §6 — the primary/write-gate matrix. On a read-only (copied/restored) server EVERY push is 403,
        // and the gate runs BEFORE the dup scanner: a duplicate-key body on a read-only server is 403
        // (gate), NOT 400 (dup) — pinning gate-before-dup order behaviourally. Nothing is written.
        #[tokio::test]
        async fn primary_gate_matrix() {
            let cases: &[(&str, Vec<u8>)] = &[
                ("P1 valid push", valid_push_of_size(300)),
                ("P2 dup-key push", envelope_dup_body()),
                ("P3 max allowed push", valid_push_of_size(1024)),
            ];
            for (label, body) in cases {
                let s = state(primary::State::ReadOnly);
                let before = snapshot(&s).await;
                let r = router(s.clone(), 1024)
                    .oneshot(req(Some(&token()), Some("application/json"), body.clone()))
                    .await
                    .unwrap();
                assert_eq!(r.status().as_u16(), 403, "{label} on read-only → 403 (gate before dup parse)");
                assert_eq!(snapshot(&s).await, before, "{label}: DB untouched");
            }
        }

        // §8 — one full, legitimate desktop push through the whole router (valid auth, active primary,
        // application/json, allowed table/op/fields): 200, exactly one changelog row, no quarantine. Plus
        // the legacy-activity contract: on an ARMED cutover the same successful push flips the readiness
        // invalidation flag to 1 IN THE SAME breath (record_legacy_activity), while it stays 0 on a
        // non-attested server (the normal pre-cutover case).
        #[tokio::test]
        async fn successful_desktop_push_and_activity_contract() {
            // non-attested primary → 200, one changelog row, no quarantine, NO activity mark.
            let s = state(primary::State::Primary);
            let r = router(s.clone(), MAX)
                .oneshot(req(Some(&token()), Some("application/json"), valid_push_of_size(300)))
                .await
                .unwrap();
            assert_eq!(r.status().as_u16(), 200, "valid desktop push → 200");
            assert_eq!(count(&s, "sync_changelog").await, 1, "exactly one changelog row");
            assert_eq!(count(&s, "sync_change_quarantine").await, 0, "no quarantine");
            assert_eq!(activity_marks(&s).await, 0, "no attestation → no legacy-activity mark");

            // armed primary → the same push lands AND invalidates readiness together.
            let a = armed_state();
            let ra = router(a.clone(), MAX)
                .oneshot(req(Some(&token()), Some("application/json"), valid_push_of_size(300)))
                .await
                .unwrap();
            assert_eq!(ra.status().as_u16(), 200, "valid desktop push on armed cutover → 200");
            assert_eq!(count(&a, "sync_changelog").await, 1, "one changelog row");
            assert_eq!(activity_marks(&a).await, 1, "armed attestation → legacy activity marked in the same tx");
        }

        // §3 — the content-type contract through the REAL router, on a writable primary. The restored
        // JSON content-type check accepts application/json (with or without a charset parameter) and any
        // application/*+json vendor type, and refuses a missing header, text/plain and
        // application/octet-stream with 415 — writing nothing. Every supported producer sends
        // application/json, so C1/C2 are the real-world calls; C3 proves the +json suffix; C4–C6 are the
        // refused shapes. This corrects the SILENT loosening the B3A `Bytes` switch introduced (a
        // missing content-type used to be accepted); it is now 415, matching the pre-B3A `Json` contract.
        #[tokio::test]
        async fn content_type_contract() {
            let good = valid_push_of_size(300);
            for (label, ct) in &[
                ("C1 application/json", "application/json"),
                ("C2 json + charset", "application/json; charset=utf-8"),
                ("C3 vendor +json", "application/vnd.lataif+json"),
            ] {
                let s = state(primary::State::Primary);
                let r = router(s.clone(), MAX)
                    .oneshot(req(Some(&token()), Some(ct), good.clone()))
                    .await
                    .unwrap();
                assert_eq!(r.status().as_u16(), 200, "{label} → accepted");
                assert_eq!(count(&s, "sync_changelog").await, 1, "{label}: one changelog row");
            }
            for (label, ct) in &[
                ("C4 missing", None),
                ("C5 text/plain", Some("text/plain")),
                ("C6 octet-stream", Some("application/octet-stream")),
            ] {
                let s = state(primary::State::Primary);
                let before = snapshot(&s).await;
                let r = router(s.clone(), MAX)
                    .oneshot(req(Some(&token()), *ct, good.clone()))
                    .await
                    .unwrap();
                assert_eq!(r.status().as_u16(), 415, "{label} → 415 Unsupported Media Type");
                assert_eq!(snapshot(&s).await, before, "{label}: DB untouched (no changelog/quarantine/mark)");
            }
        }

        // §4 — the full JSON route matrix through the REAL router (valid auth, active primary,
        // application/json). J1 is the only success; J2–J11 are each a 400 that rejects the WHOLE request
        // with no partial processing, no changelog row, no quarantine row and no activity mark. J8/J9 are
        // envelope duplicate keys (identical and \u-escaped-equivalent); J10 is a duplicate key inside the
        // `data` payload (caught by per-change validation, not the envelope scanner); J11 is non-UTF-8.
        #[tokio::test]
        async fn json_route_matrix() {
            // J1 — the positive control: a valid push is accepted.
            let s1 = state(primary::State::Primary);
            let r1 = router(s1.clone(), MAX)
                .oneshot(req(Some(&token()), Some("application/json"), valid_push_of_size(300)))
                .await
                .unwrap();
            assert_eq!(r1.status().as_u16(), 200, "J1 valid push → 200");
            assert_eq!(count(&s1, "sync_changelog").await, 1);

            // J9 — a \u-escaped key that DECODES to `table_name`, duplicating the literal one. Built as a
            // normal Rust string so `\\u0074` reaches the wire as the six bytes `t`.
            let j9 = "{\"changes\":[{\"table_name\":\"products\",\"\\u0074able_name\":\"users\",\"record_id\":\"p1\",\"action\":\"insert\",\"data\":\"{}\"}]}".as_bytes().to_vec();
            let bad: &[(&str, Vec<u8>)] = &[
                ("J2 empty body", b"".to_vec()),
                ("J3 whitespace only", b"   ".to_vec()),
                ("J4 malformed JSON", b"not json at all".to_vec()),
                ("J5 trailing garbage", br#"{"changes":[]}x"#.to_vec()),
                ("J6 wrong top-level struct", br#"{"foo":1}"#.to_vec()),
                ("J7 wrong envelope field types", br#"{"changes":{}}"#.to_vec()),
                ("J8 identical envelope dup key", br#"{"changes":[{"table_name":"products","table_name":"users","record_id":"p1","action":"insert","data":"{}"}]}"#.to_vec()),
                ("J9 escaped-equivalent envelope dup key", j9),
                ("J10 dup key in inner data", inner_dup_body()),
                ("J11 non-UTF-8", vec![0xff, 0xfe, 0x00, 0x01]),
            ];
            for (label, body) in bad {
                let s = state(primary::State::Primary);
                let before = snapshot(&s).await;
                let r = router(s.clone(), MAX)
                    .oneshot(req(Some(&token()), Some("application/json"), body.clone()))
                    .await
                    .unwrap();
                assert_eq!(r.status().as_u16(), 400, "{label} → 400, whole request rejected");
                assert_eq!(snapshot(&s).await, before, "{label}: no partial processing (DB untouched)");
            }
        }

        // §9 — the released mobile picture-uploader payloads (v0.8.23 = current, mobile_page.rs) driven
        // through the WHOLE router. The purchase_inbox INSERT the desktop never emits — the case a
        // desktop-only operation matrix would have wrongly quarantined — is accepted here, plus products
        // and repairs inserts. Each lands exactly one changelog row and NOTHING is quarantined.
        #[tokio::test]
        async fn released_mobile_through_router() {
            let mobile: &[(&str, &str, &str)] = &[
                ("purchase_inbox insert", "purchase_inbox", r#"{"id":"pi1","branch_id":"b","images":"[]","note":null,"status":"pending","created_at":"t","created_by":null}"#),
                ("products insert", "products", r#"{"id":"p1","branch_id":"b","category_id":"cat-watch","brand":"Rolex","name":"Sub","sku":null,"quantity":1,"condition":"","scope_of_delivery":"[]","purchase_date":"2026-07-18","purchase_price":100,"purchase_currency":"BHD","planned_sale_price":null,"stock_status":"in_stock","tax_scheme":"MARGIN","source_type":"OWN","notes":null,"images":"[]","image_hash":null,"attributes":"{}","created_at":"t","updated_at":"t","created_by":null}"#),
                ("repairs insert", "repairs", r#"{"id":"r1","branch_id":"b","repair_number":"REP","voucher_code":"ABCD1234","customer_id":"c1","item_brand":"X","item_model":"Y","issue_description":"broken","repair_type":"internal","status":"received","received_at":"t","images":"[]","notes":null,"created_at":"t","updated_at":"t","created_by":null}"#),
            ];
            for (label, table, data) in mobile {
                let s = state(primary::State::Primary);
                // json! serialises `data` (a &str of inner JSON) as the escaped string the `data` field
                // expects — no brace-escaping, no chance of a malformed envelope skewing the result.
                let body = serde_json::json!({
                    "changes": [{ "table_name": table, "record_id": "x", "action": "insert", "data": data }]
                })
                .to_string();
                let r = router(s.clone(), MAX)
                    .oneshot(req(Some(&token()), Some("application/json"), body.into_bytes()))
                    .await
                    .unwrap();
                assert_eq!(r.status().as_u16(), 200, "{label}: released mobile payload accepted (not SYNC_OPERATION_NOT_ALLOWED)");
                assert_eq!(count(&s, "sync_changelog").await, 1, "{label}: one changelog row");
                assert_eq!(count(&s, "sync_change_quarantine").await, 0, "{label}: no quarantine");
            }
        }

        // §2/§3 (B3A5) — the FULL negative router matrix, EVERY case run against an ARMED cutover row
        // (state=ready_for_protocol_activation, current_attestation_id=att-1). Each rejection leaves the
        // COMPLETE snapshot byte-identical: no changelog, no quarantine, and — the point of this slice —
        // no cutover-state change. `state` stays ready_for_protocol_activation (NEVER activation_blocked),
        // the attestation id, the activity flag and the activity timestamp are untouched. The write-gate
        // cases (P1–P3) use an armed READ-ONLY server so the 403 path runs over the same armed row; every
        // other class rejects on an armed primary after the gate. Because the row is armed, a state change
        // here would be a REAL regression (a rejected request invalidating readiness), so "unchanged" is
        // a strong proof, not a vacuous one.
        #[tokio::test]
        async fn full_cutover_nonmutation_matrix() {
            // (label, read_only, token, content_type, body, body_limit)
            struct C(&'static str, bool, Option<&'static str>, Option<&'static str>, Vec<u8>, usize);
            let dup = envelope_dup_body();
            let inner = inner_dup_body();
            let big = valid_push_of_size(300);
            let cases = vec![
                // A — auth (armed primary; 401 at the route_layer, before the handler)
                C("A1 unauth valid", false, None, Some("application/json"), big.clone(), MAX),
                C("A2 unauth dup", false, None, Some("application/json"), dup.clone(), MAX),
                C("A3 unauth large", false, None, Some("application/json"), valid_push_of_size(900), 1024),
                C("A4 unauth oversized", false, None, Some("application/json"), vec![b'a'; 4096], 1024),
                C("A5 invalid token", false, Some("x.y.z"), Some("application/json"), big.clone(), MAX),
                // P — write gate (armed READ-ONLY; 403 before dup/parse)
                C("P1 ro valid", true, Some("T"), Some("application/json"), big.clone(), 1024),
                C("P2 ro dup", true, Some("T"), Some("application/json"), dup.clone(), 1024),
                C("P3 ro max", true, Some("T"), Some("application/json"), valid_push_of_size(1024), 1024),
                // C — content-type (armed primary; 415)
                C("C4 missing ct", false, Some("T"), None, big.clone(), MAX),
                C("C5 text/plain", false, Some("T"), Some("text/plain"), big.clone(), MAX),
                C("C6 octet-stream", false, Some("T"), Some("application/octet-stream"), big.clone(), MAX),
                // J — JSON matrix (armed primary; 400)
                C("J2 empty", false, Some("T"), Some("application/json"), b"".to_vec(), MAX),
                C("J3 whitespace", false, Some("T"), Some("application/json"), b"   ".to_vec(), MAX),
                C("J4 malformed", false, Some("T"), Some("application/json"), b"not json".to_vec(), MAX),
                C("J5 trailing garbage", false, Some("T"), Some("application/json"), br#"{"changes":[]}x"#.to_vec(), MAX),
                C("J6 wrong struct", false, Some("T"), Some("application/json"), br#"{"foo":1}"#.to_vec(), MAX),
                C("J7 wrong types", false, Some("T"), Some("application/json"), br#"{"changes":{}}"#.to_vec(), MAX),
                C("J8 envelope dup", false, Some("T"), Some("application/json"), dup.clone(), MAX),
                C("J9 escaped dup", false, Some("T"), Some("application/json"), "{\"changes\":[{\"table_name\":\"products\",\"\\u0074able_name\":\"users\",\"record_id\":\"p1\",\"action\":\"insert\",\"data\":\"{}\"}]}".as_bytes().to_vec(), MAX),
                C("J10 inner dup", false, Some("T"), Some("application/json"), inner.clone(), MAX),
                C("J11 non-utf8", false, Some("T"), Some("application/json"), vec![0xff, 0xfe, 0x00, 0x01], MAX),
                // Body-limit (armed primary; 413 at Bytes extraction)
                C("BL over limit", false, Some("T"), Some("application/json"), vec![b'a'; 2048], 1024),
                C("BL stream over", false, Some("T"), Some("application/json"), vec![b'a'; 200], 64),
                // Schema (armed primary; 400/403 in apply, before record_legacy_activity + commit)
                C("S unknown table", false, Some("T"), Some("application/json"), br#"{"changes":[{"table_name":"nope_table","record_id":"r","action":"insert","data":"{}"}]}"#.to_vec(), MAX),
                C("S forbidden field", false, Some("T"), Some("application/json"), br#"{"changes":[{"table_name":"products","record_id":"p1","action":"insert","data":"{\"id\":\"p1\",\"evil_col\":1}"}]}"#.to_vec(), MAX),
                C("S disallowed op", false, Some("T"), Some("application/json"), br#"{"changes":[{"table_name":"ledger_entries","record_id":"l1","action":"delete","data":"{}"}]}"#.to_vec(), MAX),
                C("S control-plane", false, Some("T"), Some("application/json"), br#"{"changes":[{"table_name":"enrolled_devices","record_id":"r","action":"insert","data":"{}"}]}"#.to_vec(), MAX),
                C("S invalid identifier", false, Some("T"), Some("application/json"), br#"{"changes":[{"table_name":"Bad Table","record_id":"r","action":"insert","data":"{}"}]}"#.to_vec(), MAX),
            ];
            let armed_precondition =
                Some(("ready_for_protocol_activation".to_string(), 0i64, None, Some("att-1".to_string())));
            for C(label, ro, tok, ct, body, limit) in &cases {
                let s = armed_with(if *ro { primary::State::ReadOnly } else { primary::State::Primary });
                let before = snapshot(&s).await;
                assert_eq!(before.cutover, armed_precondition, "{label}: armed precondition (attested + ready)");
                let real_tok: Option<String> = match *tok {
                    None => None,
                    Some("T") => Some(token()),
                    Some(other) => Some(other.to_string()),
                };
                let r = router(s.clone(), *limit)
                    .oneshot(req(real_tok.as_deref(), *ct, body.clone()))
                    .await
                    .unwrap();
                let code = r.status().as_u16();
                assert!(code >= 400, "{label}: must be rejected, got {code}");
                let after = snapshot(&s).await;
                assert_eq!(after, before, "{label}: FULL cutover snapshot byte-identical (status {code})");
                assert_eq!(
                    after.cutover.as_ref().map(|c| c.0.as_str()),
                    Some("ready_for_protocol_activation"),
                    "{label}: a rejected request must NOT set state=activation_blocked"
                );
            }
        }

        // §4 (B3A5) — the positive attestation contract through the REAL router, and its exact negative.
        // Fixture: attested + readiness-capable (state=ready_for_protocol_activation,
        // current_attestation_id=att-1). A valid authorised legacy push lands one changelog row AND
        // invalidates readiness in the SAME transaction: state → activation_blocked, flag → 1, timestamp
        // set, and the attestation id is PRESERVED (record_legacy_activity records which attestation was
        // overtaken; only a re-attestation replaces it — see cutover.rs). From the SAME prepared state a
        // REJECTED push (invalid identifier / control-plane / duplicate key / disallowed operation)
        // changes NOTHING: no changelog, state stays ready_for_protocol_activation.
        #[tokio::test]
        async fn attested_push_invalidates_readiness_but_rejections_do_not() {
            // positive — a valid push blocks activation together with the changelog row.
            let s = armed_state();
            let r = router(s.clone(), MAX)
                .oneshot(req(Some(&token()), Some("application/json"), valid_push_of_size(300)))
                .await
                .unwrap();
            assert_eq!(r.status().as_u16(), 200, "attested valid push → 200");
            let after = snapshot(&s).await;
            assert_eq!(after.changelog, 1, "exactly one changelog row");
            assert_eq!(after.quarantine, 0, "no quarantine");
            let cut = after.cutover.expect("cutover row present");
            assert_eq!(cut.0, "activation_blocked", "readiness invalidated → activation_blocked");
            assert_eq!(cut.1, 1, "legacy_activity_after_attestation = 1");
            assert!(cut.2.is_some(), "last_legacy_activity_at set");
            assert_eq!(cut.3.as_deref(), Some("att-1"), "current_attestation_id preserved (records the overtaken attestation)");

            // negative — the SAME prepared state (fresh armed fixture each), four rejection classes, each inert.
            let rejects: &[(&str, Vec<u8>)] = &[
                ("invalid identifier", br#"{"changes":[{"table_name":"Bad Table","record_id":"r","action":"insert","data":"{}"}]}"#.to_vec()),
                ("control plane", br#"{"changes":[{"table_name":"enrolled_devices","record_id":"r","action":"insert","data":"{}"}]}"#.to_vec()),
                ("duplicate key", envelope_dup_body()),
                ("disallowed operation", br#"{"changes":[{"table_name":"ledger_entries","record_id":"l1","action":"delete","data":"{}"}]}"#.to_vec()),
            ];
            for (label, body) in rejects {
                let s = armed_state();
                let before = snapshot(&s).await;
                let r = router(s.clone(), MAX)
                    .oneshot(req(Some(&token()), Some("application/json"), body.clone()))
                    .await
                    .unwrap();
                assert!(r.status().as_u16() >= 400, "{label}: rejected");
                let after = snapshot(&s).await;
                assert_eq!(after.changelog, 0, "{label}: no changelog row");
                assert_eq!(after, before, "{label}: cutover state unchanged");
                assert_eq!(
                    after.cutover.as_ref().map(|c| c.0.as_str()),
                    Some("ready_for_protocol_activation"),
                    "{label}: state must stay ready_for_protocol_activation (readiness NOT invalidated by a rejected push)"
                );
            }
        }
    }
}

// Produkt direkt aus der Frontend-DB (lataif.db) `products`-Tabelle lesen — read-only,
// damit der laufende sql.js-Schreiber nicht blockiert wird. Liefert das Produkt-JSON in
// genau der Form, die die Mobile-Seite (renderProduct) erwartet: images/attributes/
// scope_of_delivery bleiben JSON-Strings, Preise als Zahl. None => Caller nutzt Fallback.
fn product_from_frontend_db(db_path: &std::path::Path, sku: &str) -> Option<serde_json::Value> {
    use rusqlite::OpenFlags;
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;

    let mut product = conn
        .prepare(
            "SELECT brand, name, sku, condition, scope_of_delivery, storage_location,
                    purchase_price, planned_sale_price, min_sale_price, max_sale_price,
                    stock_status, images, attributes, category_id
             FROM products WHERE sku = ?1 LIMIT 1",
        )
        .ok()?
        .query_row(rusqlite::params![sku], |r| {
            Ok(serde_json::json!({
                "brand":             r.get::<_, Option<String>>(0)?,
                "name":              r.get::<_, Option<String>>(1)?,
                "sku":               r.get::<_, Option<String>>(2)?,
                "condition":         r.get::<_, Option<String>>(3)?,
                "scope_of_delivery": r.get::<_, Option<String>>(4)?,
                "storage_location":  r.get::<_, Option<String>>(5)?,
                "purchase_price":    col_num(r, 6),
                "planned_sale_price": col_num(r, 7),
                "min_sale_price":    col_num(r, 8),
                "max_sale_price":    col_num(r, 9),
                "stock_status":      r.get::<_, Option<String>>(10)?,
                "images":            r.get::<_, Option<String>>(11)?,
                "attributes":        r.get::<_, Option<String>>(12)?,
                "category_id":       r.get::<_, Option<String>>(13)?,
            }))
        })
        .ok()?;

    // Kategorie-Name aufloesen (fuer die Anzeige) — fehlt sie, bleibt category_id.
    if let Some(cat_id) = product
        .get("category_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
    {
        if let Ok(name) = conn.query_row(
            "SELECT name FROM categories WHERE id = ?1",
            rusqlite::params![cat_id],
            |r| r.get::<_, String>(0),
        ) {
            product["category_name"] = serde_json::Value::String(name);
        }
    }

    Some(product)
}
