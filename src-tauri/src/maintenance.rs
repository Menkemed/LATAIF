//! WARTUNGSMODUS — solange eine Owner-Wartung am Primary schreibt (Bildmigration), nimmt der Server keine
//! verändernden Aufträge von PC2 oder vom Handy an.
//!
//! * Verändernd ist jeder `/api/command`-Auftrag außer Lesen (`….get`, `….list`) und der Probe, dazu jeder
//!   POST auf eine reine Schreibroute (Sync-Push, Inventur-Check, Handy-Upload, Ablage, Dokument).
//! * Die Antwort ist 503 `MAINTENANCE_ACTIVE` mit `outcome: not_executed` — der Client weiß, dass nichts
//!   geschehen ist; das Handy behält seinen Upload und versucht es später erneut (503 = vorübergehend).
//! * Lesen bleibt erlaubt.
//! * Der Zustand lebt nur im Speicher: ein Neustart (auch nach einem Absturz) beendet den Wartungsmodus.
//!
//! Dazu das Wartungsprotokoll: Zeilen (JSON, nur Kennungen und Zahlen) in
//! `<Datenordner>/maintenance-logs/<name>.jsonl`, nur anhängend, nie überschreibend.

use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(not(test))]
use std::sync::Mutex;

use axum::http::{HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;

pub const MAINTENANCE_ACTIVE: &str = "MAINTENANCE_ACTIVE";
pub const LOG_DIRNAME: &str = "maintenance-logs";

#[cfg(not(test))]
static STATE: Mutex<Option<String>> = Mutex::new(None);

// In Tests je Thread: parallel laufende Router-Tests anderer Module dürfen den Wartungsmodus eines Tests
// nie sehen (sie bekämen sonst ein 503). `#[tokio::test]` läuft auf einem Thread.
#[cfg(test)]
thread_local! {
    static STATE_T: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

fn normalized(active: bool, reason: &str) -> Option<String> {
    if active { Some(if reason.trim().is_empty() { "maintenance".to_string() } else { reason.trim().to_string() }) } else { None }
}

#[cfg(not(test))]
pub fn set(active: bool, reason: &str) {
    let mut s = STATE.lock().unwrap_or_else(|p| p.into_inner());
    *s = normalized(active, reason);
}

#[cfg(not(test))]
pub fn is_active() -> bool {
    // Fail-closed: eine vergiftete Sperre heißt „Wartung" (abweisen ist sicherer als durchlassen).
    STATE.lock().map(|s| s.is_some()).unwrap_or(true)
}

#[cfg(not(test))]
pub fn reason() -> Option<String> {
    STATE.lock().ok().and_then(|s| s.clone())
}

#[cfg(test)]
pub fn set(active: bool, reason: &str) {
    STATE_T.with(|s| *s.borrow_mut() = normalized(active, reason));
}

#[cfg(test)]
pub fn is_active() -> bool {
    STATE_T.with(|s| s.borrow().is_some())
}

#[cfg(test)]
pub fn reason() -> Option<String> {
    STATE_T.with(|s| s.borrow().clone())
}

/// Ein Fernauftrag verändert Geschäftsdaten, wenn er weder die Probe noch ein Lesen ist. Lesen heißt
/// ausnahmslos `….get` / `….list` (geprüft gegen die Liste der freigegebenen Mutationen im Renderer).
pub fn op_is_mutation(op: &str) -> bool {
    !(op == crate::bridge::OP_PROBE || op.ends_with(".get") || op.ends_with(".list"))
}

/// Reine Schreibrouten unter `/api` (der Pfad kann mit oder ohne `/api`-Präfix ankommen).
const WRITE_ROUTES: &[&str] = &["/sync/push", "/stock-checks", "/mobile/upload", "/staging/media", "/documents/raw"];

pub fn path_is_write(method: &Method, path: &str) -> bool {
    method == Method::POST && WRITE_ROUTES.iter().any(|r| path == *r || path.ends_with(r))
}

pub fn refusal() -> Response {
    let mut res = (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({
            "ok": false,
            "error": MAINTENANCE_ACTIVE,
            "outcome": "not_executed",
            "message": "The main computer is running owner maintenance. Nothing was saved - please try again in a few minutes.",
        })),
    )
        .into_response();
    res.headers_mut().insert(axum::http::header::RETRY_AFTER, HeaderValue::from_static("120"));
    res
}

/// Middleware vor den geschützten `/api`-Routen: reine Schreibrouten im Wartungsmodus abweisen.
/// (`/api/command` prüft selbst, weil erst der Rumpf sagt, ob ein Auftrag liest oder schreibt.)
pub async fn gate(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    if is_active() && path_is_write(req.method(), req.uri().path()) {
        // Erst den Rumpf zu Ende lesen, DANN antworten: wer mitten in einem großen Upload (Foto, Dokument) eine
        // Antwort bekommt und die Verbindung verliert, sieht einen Netzwerkfehler („unbekannt") statt eines
        // sauberen „nicht ausgeführt" — beim zweiten Rechner wäre das ein ungeklärter Speichervorgang.
        let _ = axum::body::to_bytes(req.into_body(), MAX_DRAIN_BYTES).await;
        return refusal();
    }
    next.run(req).await
}

/// Obergrenze beim Leerlesen eines abgewiesenen Rumpfs (über jeder Routen-Grenze; danach wird nur noch geantwortet).
const MAX_DRAIN_BYTES: usize = 64 * 1024 * 1024;

fn valid_log_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !name.starts_with('.')
        && !name.contains("..")
}

pub fn log_path(root: &Path, name: &str) -> Result<PathBuf, String> {
    if !valid_log_name(name) {
        return Err("MAINTENANCE_LOG_NAME_INVALID".into());
    }
    Ok(root.join(LOG_DIRNAME).join(format!("{name}.jsonl")))
}

/// Eine Zeile anhängen (eine JSON-Zeile, ohne Zeilenumbrüche darin). Legt Ordner und Datei bei Bedarf an.
pub fn append_log(root: &Path, name: &str, line: &str) -> Result<(), String> {
    if line.contains('\n') || line.contains('\r') || line.len() > 64 * 1024 {
        return Err("MAINTENANCE_LOG_LINE_INVALID".into());
    }
    let path = log_path(root, name)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("MAINTENANCE_LOG_IO: {e}"))?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("MAINTENANCE_LOG_IO: {e}"))?;
    f.write_all(line.as_bytes()).and_then(|_| f.write_all(b"\n")).and_then(|_| f.sync_data())
        .map_err(|e| format!("MAINTENANCE_LOG_IO: {e}"))
}

#[cfg(test)]
#[path = "maintenance_tests.rs"]
mod tests;
