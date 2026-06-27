// ═══════════════════════════════════════════════════════════
// LATAIF — Sync Server
// REST API for multi-device synchronization
// ═══════════════════════════════════════════════════════════

mod db;
mod auth;
mod routes;
mod models;

use axum::Router;
use std::sync::Arc;
use tokio::sync::Mutex;
use tower_http::cors::{CorsLayer, Any};
use tracing_subscriber;

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub jwt_secret: String,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    // Initialize database
    let conn = db::init_database().expect("Failed to initialize database");

    let state = Arc::new(AppState {
        db: Mutex::new(conn),
        jwt_secret: std::env::var("JWT_SECRET").unwrap_or_else(|_| "lataif_secret_2026_change_in_production".to_string()),
    });

    // CORS — allow desktop + mobile apps
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .nest("/api", routes::api_routes())
        .layer(cors)
        .with_state(state);

    let addr = "0.0.0.0:3001";
    tracing::info!("LATAIF Server running on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
