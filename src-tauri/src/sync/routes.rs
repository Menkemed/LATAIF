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

pub fn api_routes() -> Router<Arc<AppState>> {
    let protected = Router::new()
        .route("/sync/push", post(sync_push))
        .route("/sync/pull", get(sync_pull))
        .route("/me", get(get_me))
        .route("/products/by-sku/{sku}", get(product_by_sku))
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
                    row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?,
                    row.get(4)?, row.get(5)?, row.get(6)?,
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
        token, user_id, tenant_id, branch_id, role, user_name, branch_name,
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

    let password_hash = bcrypt::hash(&req.password, 10)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

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
        token, user_id, tenant_id, branch_id,
        role: "owner".to_string(), user_name: req.user_name, branch_name: req.branch_name,
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
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = state.db.lock().await;
    let now = chrono::Utc::now().to_rfc3339();
    let mut count = 0;

    for change in &req.changes {
        db.execute(
            "INSERT INTO sync_changelog (tenant_id, branch_id, table_name, record_id, action, data, user_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![claims.tenant_id, claims.branch_id, change.table_name, change.record_id, change.action, change.data, claims.sub, now],
        ).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        count += 1;
    }

    Ok(Json(serde_json::json!({ "synced": count })))
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

    Ok(Json(SyncPullResponse { changes, last_sync_id }))
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
            stmt.query_row(rusqlite::params![claims.tenant_id, record_id], |row| row.get(0))
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
                stmt.query_row(rusqlite::params![claims.tenant_id, cat_id], |row| row.get(0))
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
        Ok(ValueRef::Text(t)) => std::str::from_utf8(t).ok().and_then(|s| s.trim().parse::<f64>().ok()),
        _ => None,
    }
}

// Produkt direkt aus der Frontend-DB (lataif.db) `products`-Tabelle lesen — read-only,
// damit der laufende sql.js-Schreiber nicht blockiert wird. Liefert das Produkt-JSON in
// genau der Form, die die Mobile-Seite (renderProduct) erwartet: images/attributes/
// scope_of_delivery bleiben JSON-Strings, Preise als Zahl. None => Caller nutzt Fallback.
fn product_from_frontend_db(
    db_path: &std::path::Path,
    sku: &str,
) -> Option<serde_json::Value> {
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
