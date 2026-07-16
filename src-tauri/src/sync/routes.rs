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
pub fn apply_legacy_push_batch(
    conn: &mut rusqlite::Connection,
    tenant_id: &str,
    branch_id: &str,
    user_id: &str,
    now: &str,
    changes: &[SyncPushChange],
) -> rusqlite::Result<usize> {
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
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

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

    Ok(Json(SyncPullResponse {
        changes,
        last_sync_id,
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
            "CREATE TABLE sync_changelog (
                id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
                branch_id TEXT NOT NULL, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
                action TEXT NOT NULL, data TEXT NOT NULL, user_id TEXT, created_at TEXT NOT NULL
            );",
        )
        .unwrap();
        conn
    }

    fn change(record_id: &str) -> SyncPushChange {
        SyncPushChange {
            table_name: "products".into(),
            record_id: record_id.into(),
            action: "update".into(),
            data: format!("{{\"id\":\"{record_id}\"}}"),
        }
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

    fn push(conn: &mut Connection, changes: &[SyncPushChange]) -> rusqlite::Result<usize> {
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
