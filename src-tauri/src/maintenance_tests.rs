//! WARTUNGSMODUS — Einordnung der Fernaufträge, Sperre der Schreibrouten, Protokolldatei.
use super::*;
use axum::{body::Body, http::Request, routing::{get, post}, Router};
use tower::util::ServiceExt;

/// Die freigegebenen verändernden Fernaufträge des Renderers (`ALLOWED_MUTATIONS`), aus der Quelle gelesen.
fn renderer_mutations() -> Vec<String> {
    let src = include_str!("../../src/core/bridge/command-registry.ts");
    let start = src.find("export const ALLOWED_MUTATIONS").expect("ALLOWED_MUTATIONS");
    let body = &src[start..];
    let end = body.find("\n];").expect("Listenende");
    let mut out = Vec::new();
    for line in body[..end].lines() {
        let code = line.split("//").next().unwrap_or("");
        let mut rest = code;
        while let Some(a) = rest.find('\'') {
            let after = &rest[a + 1..];
            let Some(b) = after.find('\'') else { break };
            out.push(after[..b].to_string());
            rest = &after[b + 1..];
        }
    }
    out
}

#[test]
fn jede_freigegebene_mutation_gilt_als_veraendernd() {
    let m = renderer_mutations();
    assert!(m.len() > 50, "Liste gelesen ({})", m.len());
    for op in &m {
        assert!(op_is_mutation(op), "{op} muss im Wartungsmodus abgewiesen werden");
    }
}

#[test]
fn jeder_fernauftrag_ist_entweder_lesen_oder_freigegebene_mutation() {
    let m = renderer_mutations();
    for op in crate::bridge::REMOTE_OPS {
        if op_is_mutation(op) {
            assert!(m.iter().any(|x| x == op), "{op} gilt als verändernd, steht aber nicht in ALLOWED_MUTATIONS");
        } else {
            assert!(!m.iter().any(|x| x == op), "{op} steht in ALLOWED_MUTATIONS, gilt aber als Lesen");
        }
    }
    assert!(!op_is_mutation(crate::bridge::OP_PROBE), "die Probe bleibt erlaubt");
    assert!(!op_is_mutation("products.get") && !op_is_mutation("store.products.get") && !op_is_mutation("products.list"));
    assert!(op_is_mutation("products.update") && op_is_mutation("purchase_inbox.create") && op_is_mutation("transfers.remove"));
}

#[test]
fn schreibrouten_sind_genau_die_post_routen() {
    for p in ["/sync/push", "/stock-checks", "/mobile/upload", "/staging/media", "/documents/raw", "/api/mobile/upload", "/api/staging/media"] {
        assert!(path_is_write(&Method::POST, p), "{p}");
    }
    assert!(!path_is_write(&Method::GET, "/stock-checks"), "Inventur-Liste lesen bleibt");
    assert!(!path_is_write(&Method::GET, "/mobile/upload/abc"), "Status eines Handy-Uploads lesen bleibt");
    for p in ["/media", "/products/search", "/ai/identify", "/command", "/command/status", "/me", "/sync/pull"] {
        assert!(!path_is_write(&Method::POST, p), "{p} ist keine reine Schreibroute");
    }
}

fn router() -> Router {
    Router::new()
        .route("/staging/media", post(|| async { "stored" }))
        .route("/mobile/upload", post(|| async { "accepted" }))
        .route("/media", get(|| async { "bytes" }))
        .route("/stock-checks", get(|| async { "list" }).post(|| async { "checked" }))
        .route_layer(axum::middleware::from_fn(gate))
}

async fn call(method: &str, uri: &str) -> (u16, String, Option<String>) {
    let res = router().oneshot(Request::builder().method(method).uri(uri).body(Body::empty()).unwrap()).await.unwrap();
    let status = res.status().as_u16();
    let retry = res.headers().get("retry-after").map(|v| v.to_str().unwrap_or("").to_string());
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    (status, String::from_utf8_lossy(&bytes).to_string(), retry)
}

#[tokio::test]
async fn im_wartungsmodus_schreiben_abgewiesen_lesen_erlaubt() {
    set(false, "");
    assert_eq!(call("POST", "/staging/media").await.0, 200, "ohne Wartung: Ablage geht");
    set(true, "image-store-migration");
    assert!(is_active());
    assert_eq!(reason().as_deref(), Some("image-store-migration"));
    for uri in ["/staging/media", "/mobile/upload", "/stock-checks"] {
        let (st, body, retry) = call("POST", uri).await;
        assert_eq!(st, 503, "{uri}");
        assert!(body.contains(MAINTENANCE_ACTIVE) && body.contains("not_executed"), "{uri}: {body}");
        assert_eq!(retry.as_deref(), Some("120"), "{uri}: Handy versucht es später erneut");
    }
    assert_eq!(call("GET", "/media").await.0, 200, "Bilder lesen bleibt erlaubt");
    assert_eq!(call("GET", "/stock-checks").await.0, 200, "Liste lesen bleibt erlaubt");
    set(false, "");
    assert!(!is_active());
    assert_eq!(call("POST", "/mobile/upload").await.0, 200, "nach der Wartung: Handy-Upload geht wieder");
}

#[tokio::test]
async fn ein_grosser_upload_wird_zu_ende_gelesen_und_sauber_abgewiesen() {
    set(true, "image-store-migration");
    let body = vec![b'x'; 3 * 1024 * 1024];
    let res = router()
        .oneshot(Request::builder().method("POST").uri("/staging/media").body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    set(false, "");
    assert_eq!(status, 503);
    assert!(String::from_utf8_lossy(&bytes).contains("not_executed"), "sauberes „nicht ausgeführt“ statt Verbindungsabbruch");
    let src = include_str!("maintenance.rs");
    let gate_fn = &src[src.find("pub async fn gate").unwrap()..];
    assert!(gate_fn.find("to_bytes(req.into_body()").unwrap() < gate_fn.find("return refusal()").unwrap(), "erst lesen, dann antworten");
}

#[test]
fn der_fernauftrag_prueft_den_wartungsmodus_vor_der_bruecke() {
    let src = include_str!("sync/routes.rs");
    let f = &src[src.find("async fn command_execute").expect("command_execute")..];
    let gate = f.find("crate::maintenance::is_active()").expect("Wartungsprüfung im Fernauftrag");
    let submit = f.find(".submit_as(").expect("submit_as");
    assert!(gate < submit, "die Prüfung steht VOR dem Weiterreichen an den Renderer");
    assert!(src.contains(".route_layer(middleware::from_fn(crate::maintenance::gate))"), "Schreibrouten-Sperre eingehängt");
    let routes = &src[..src.find("\"/auth/login\"").expect("öffentliche Routen")];
    let g = routes.find("crate::maintenance::gate").unwrap();
    let a = routes.find("auth::auth_middleware").unwrap();
    assert!(g < a, "die Sperre liegt innen, die Anmeldung läuft zuerst");
}

#[test]
fn protokoll_haengt_an_und_weist_unsichere_namen_ab() {
    let dir = std::env::temp_dir().join(format!("lataif-maint-log-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    append_log(&dir, "img-mig-20261116-abc123", "{\"event\":\"start\"}").unwrap();
    append_log(&dir, "img-mig-20261116-abc123", "{\"event\":\"done\"}").unwrap();
    let text = std::fs::read_to_string(dir.join(LOG_DIRNAME).join("img-mig-20261116-abc123.jsonl")).unwrap();
    assert_eq!(text, "{\"event\":\"start\"}\n{\"event\":\"done\"}\n");
    for bad in ["", "../x", "a/b", "a\\b", ".hidden", "x..y", "name with space"] {
        assert!(append_log(&dir, bad, "{}").is_err(), "{bad:?} abgewiesen");
    }
    assert!(append_log(&dir, "ok-name", "zwei\nzeilen").is_err(), "eine Zeile bleibt eine Zeile");
    let _ = std::fs::remove_dir_all(&dir);
}
