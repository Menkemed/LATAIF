// ═══════════════════════════════════════════════════════════
// LATAIF — Sync Server
// REST API for multi-device synchronization
// ═══════════════════════════════════════════════════════════

mod auth;
mod authoritative_sync;
mod db;
mod models;
mod operations;
mod routes;

use axum::Router;
use std::sync::Arc;
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber;

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub jwt_secret: String,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    // Fail closed: refuse to start unless a JWT secret is explicitly configured.
    // Never fall back to a hard-coded development secret in a running server.
    let jwt_secret = match auth::load_jwt_secret() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("FATAL: {e}");
            std::process::exit(1);
        }
    };

    // Initialize database
    let conn = db::init_database().expect("Failed to initialize database");

    let state = Arc::new(AppState {
        db: Mutex::new(conn),
        jwt_secret,
    });

    // CORS — allow desktop + mobile apps
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .nest("/api", routes::api_routes(state.clone()))
        .layer(cors)
        .with_state(state);

    // Bind address is env-configurable (test harnesses bind an isolated port);
    // defaults to the production port. Contract-neutral.
    let addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:3001".to_string());
    tracing::info!("LATAIF Server running on {}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

// M6-B1: `migrations` now lives in the library surface (`lataif_server::migrations`)
// so the embedded Tauri sync server reuses the same runner. The binary consumes it
// from there — one implementation, no in-tree copy.
use lataif_server::migrations;

#[cfg(test)]
mod route_tests;
