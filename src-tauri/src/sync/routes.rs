use axum::{
    extract::{Extension, Path, Query, State},
    http::StatusCode,
    middleware,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use std::sync::Arc;

use super::{auth, models::*, AppState};

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

async fn sync_push(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<SyncPushRequest>,
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
pub struct PullFilter {
    pub delivered: Vec<SyncChange>,
    pub scanned_max: i64,
    pub control_plane_filtered: usize,
    pub invalid_identifier_filtered: usize,
}

fn filter_forbidden_for_pull(rows: Vec<SyncChange>, since_id: i64) -> PullFilter {
    let scanned_max = rows.last().map(|c| c.id).unwrap_or(since_id);
    let mut delivered = Vec::new();
    let mut control_plane_filtered = 0usize;
    let mut invalid_identifier_filtered = 0usize;
    for c in rows {
        if super::sync_policy::is_forbidden(&c.table_name) {
            control_plane_filtered += 1;
        } else if super::sync_policy::validate_sync_table_name(&c.table_name).is_err() {
            invalid_identifier_filtered += 1;
        } else {
            delivered.push(c);
        }
    }
    PullFilter { delivered, scanned_max, control_plane_filtered, invalid_identifier_filtered }
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

    // §4 — separated diagnostics, counts only (no raw attacker value ever reaches a log line).
    if filtered.control_plane_filtered > 0 || filtered.invalid_identifier_filtered > 0 {
        eprintln!(
            "[sync] pull withheld: control_plane_filtered={} invalid_identifier={}",
            filtered.control_plane_filtered, filtered.invalid_identifier_filtered
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

        // 3. Jeder Schreibzugriff im Produktivcode geht in sync_changelog — also durch
        //    apply_legacy_push_batch, und das erreicht man nur ueber das Gate.
        let writers: Vec<&str> = ["INSERT INTO", "UPDATE ", "DELETE FROM"]
            .iter()
            .flat_map(|kw| prod.match_indices(kw).map(|(i, _)| &prod[i..(i + 40).min(prod.len())]))
            .collect();
        for w in &writers {
            assert!(
                w.contains("sync_changelog"),
                "unerwartete Schreibflaeche im Produktivcode: {w:?} — muss durch das Gate"
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
        assert_eq!(f.invalid_identifier_filtered, 0);
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
            .find("isControlPlaneTable(change.table_name)")
            .expect("the client apply guard must exist");
        let upsert = ts.find("applyUpsert(db, change.table_name").expect("applyUpsert call");
        let delete = ts.find("DELETE FROM ${change.table_name}").expect("delete path");
        // Find the guard INSIDE applyChange, then assert both the upsert and the delete come
        // after it — so a control-plane row is refused before any of the three can run.
        assert!(guard < upsert, "guard must precede the insert/update path");
        assert!(guard < delete, "guard must precede the delete path");
        // …and it throws (fail-closed), not merely skips.
        let after = &ts[guard..upsert];
        assert!(after.contains("throw new Error"), "the guard must throw, not silently skip");
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
        assert_eq!(forbidden.len(), 20, "16 control-plane + 4 internal — the whole denylist");
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
            assert_eq!(f.invalid_identifier_filtered, 0);
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
        // A canonical but UNKNOWN business table still flows — the gate is a charset, not a name
        // list. (This is the M6_FULL_BUSINESS_TABLE_ALLOWLIST_OPEN boundary, unchanged.)
        let mut conn = db();
        assert_eq!(
            push(&mut conn, &[change_on("some_new_table", "x", "update")]).unwrap(),
            1,
            "an unknown but canonical table is still accepted"
        );
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
        let throws = ts[g..body_end].contains("throw new Error");
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
                    Outcome::Invalid => assert_eq!(f.invalid_identifier_filtered, 1, "{value:?}"),
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
        assert_eq!(f.invalid_identifier_filtered, 1, "the 'DROP TABLE users' row");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // M6-B2DE4 §6 — the poisoned-changelog contract, SERVER half (a REAL push).
    //
    // A canonical, allowed table_name carrying an INVALID payload COLUMN name. This proves — not
    // assumes — that the current legacy server ACCEPTS it and it LANDS in the changelog, because
    // the server stores `data` opaquely and never parses column names. The CLIENT half (refuses on
    // apply, cursor stuck, blocks subsequent) is proven behaviorally in
    // test/m6b2de4/identifier-apply-behavior.test.ts. Together: the DoS is real, fail-closed (no
    // poison applied, no false success), and deferred to B3 — NOT fixed here.
    // ═══════════════════════════════════════════════════════════════════════
    #[test]
    fn m6_server_accepts_a_payload_column_poisoned_change_and_it_lands_in_the_changelog() {
        let mut conn = db();
        let poisoned = SyncPushChange {
            table_name: "products".into(), // canonical, allowed — passes BOTH the denylist and charset
            record_id: "p1".into(),
            action: "update".into(),
            data: "{\"BadColumn\": 1, \"another bad\": 2}".into(), // invalid column names in the payload
        };
        let n = push(&mut conn, &[poisoned]).unwrap();
        assert_eq!(
            n, 1,
            "§6: the server ACCEPTS it — table_name is canonical and the payload is opaque to the server"
        );
        let (table, data): (String, String) = conn
            .query_row(
                "SELECT table_name, data FROM sync_changelog WHERE record_id='p1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(table, "products");
        assert!(data.contains("BadColumn"), "§6: the poisoned payload landed verbatim in the changelog");

        // …and a pull WOULD deliver it: `products` is a valid business identifier, so neither the
        // control-plane denylist nor the charset gate withholds it. The poison is in the columns,
        // which the server never inspects — the client is the one that must refuse it on apply.
        let f = filter_forbidden_for_pull(vec![pull_row(1, "products")], 0);
        assert_eq!(f.delivered.len(), 1, "§6: the poisoned row is delivered — the table name is clean");
        assert_eq!(f.invalid_identifier_filtered, 0, "§6: the server-side filter cannot see the payload columns");
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
