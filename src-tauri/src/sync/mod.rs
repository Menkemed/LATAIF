use axum::{extract::DefaultBodyLimit, response::Html, Router};
use mdns_sd::{ServiceDaemon, ServiceInfo};

async fn serve_mobile_page() -> Html<&'static str> {
    Html(mobile_page::MOBILE_HTML)
}
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::{sync::Mutex, task::JoinHandle};
use tower_http::cors::{Any, CorsLayer};

pub mod auth;
pub mod db;
pub mod mobile_page;
pub mod models;
pub mod routes;

const MDNS_SERVICE: &str = "_lataif-sync._tcp.local.";

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub jwt_secret: String,
}

pub struct SyncServer {
    pub port: u16,
    pub running: Mutex<bool>,
    pub shutdown_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    pub handle: Mutex<Option<JoinHandle<()>>>,
    pub mdns: Mutex<Option<ServiceDaemon>>,
    pub db_path: PathBuf,
    /// Plan §LAN-Sync §Self-Token: beim Server-Start automatisch generierter
    /// JWT mit Owner-Claims, damit der Desktop direkt gegen seinen eigenen
    /// Server pullen kann ohne expliziten Login. Wird per Tauri-Command an
    /// das JS-Frontend ausgeliefert (autoLanSetup speichert es als Sync-Token).
    pub self_token: Mutex<Option<String>>,
}

impl SyncServer {
    pub fn new(db_path: PathBuf, port: u16) -> Self {
        Self {
            port,
            running: Mutex::new(false),
            shutdown_tx: Mutex::new(None),
            handle: Mutex::new(None),
            mdns: Mutex::new(None),
            db_path,
            self_token: Mutex::new(None),
        }
    }

    pub async fn start(&self) -> Result<String, String> {
        let mut running = self.running.lock().await;
        if *running {
            return Ok(format!("Server already running on port {}", self.port));
        }

        let conn = db::init_database(&self.db_path).map_err(|e| format!("DB init failed: {e}"))?;

        let jwt_secret = std::env::var("JWT_SECRET")
            .unwrap_or_else(|_| "lataif_secret_2026_change_in_production".to_string());

        // Plan §LAN-Sync §Self-Token: JWT für die lokale Desktop-Instanz generieren.
        // Default-Claims passen zu single-tenant single-branch Deployments — wenn
        // der User später Multi-Tenant aktiviert, kann er einen normalen Login machen
        // (überschreibt den Self-Token via setSyncConfig).
        let self_token = auth::create_token(
            "self-desktop",
            "tenant-1",
            "branch-main",
            "owner",
            &jwt_secret,
        ).map_err(|_| "Self-token generation failed".to_string())?;
        *self.self_token.lock().await = Some(self_token);

        let state = Arc::new(AppState {
            db: Mutex::new(conn),
            jwt_secret,
        });

        let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any);
        // Body-Limit auf 50 MB hochsetzen — Handy-Fotos als base64 sind oft 5-15 MB.
        let body_limit = DefaultBodyLimit::max(50 * 1024 * 1024);
        let app = Router::new()
            .nest("/api", routes::api_routes())
            .route("/mobile", axum::routing::get(serve_mobile_page))
            .route("/", axum::routing::get(serve_mobile_page))
            .layer(body_limit)
            .layer(cors)
            .with_state(state);

        let addr = format!("0.0.0.0:{}", self.port);
        let listener = tokio::net::TcpListener::bind(&addr)
            .await
            .map_err(|e| format!("Bind failed: {e}"))?;

        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        *self.shutdown_tx.lock().await = Some(shutdown_tx);
        *self.handle.lock().await = Some(handle);
        *running = true;

        // Advertise via mDNS
        if let Ok(ip) = local_ip_address::local_ip() {
            let host = ip.to_string();
            let hostname = format!("lataif-{}.local.", host.replace('.', "-"));
            if let Ok(mdns) = ServiceDaemon::new() {
                let info = ServiceInfo::new(
                    MDNS_SERVICE,
                    &format!("lataif-{}", host.replace('.', "-")),
                    &hostname,
                    &host,
                    self.port,
                    &[("version", "1")][..],
                );
                if let Ok(info) = info {
                    let _ = mdns.register(info);
                    *self.mdns.lock().await = Some(mdns);
                }
            }
        }

        Ok(format!("Server started on port {}", self.port))
    }

    pub async fn stop(&self) -> Result<String, String> {
        let mut running = self.running.lock().await;
        if !*running {
            return Ok("Server not running".into());
        }

        if let Some(mdns) = self.mdns.lock().await.take() {
            let _ = mdns.shutdown();
        }
        if let Some(tx) = self.shutdown_tx.lock().await.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.handle.lock().await.take() {
            handle.abort();
        }

        *running = false;
        Ok("Server stopped".into())
    }

    pub async fn status(&self) -> (bool, u16, Option<String>) {
        (
            *self.running.lock().await,
            self.port,
            self.self_token.lock().await.clone(),
        )
    }
}

/// Browse the LAN for a running LATAIF sync server.
/// Returns first discovered endpoint as "http://ip:port" or None.
pub async fn discover_lan_servers(timeout_secs: u64) -> Vec<String> {
    let mut results = Vec::new();
    let mdns = match ServiceDaemon::new() {
        Ok(m) => m,
        Err(_) => return results,
    };

    let receiver = match mdns.browse(MDNS_SERVICE) {
        Ok(r) => r,
        Err(_) => return results,
    };

    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);

    while std::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        match tokio::time::timeout(remaining, async {
            receiver.recv_async().await
        })
        .await
        {
            Ok(Ok(event)) => {
                if let mdns_sd::ServiceEvent::ServiceResolved(info) = event {
                    for ip in info.get_addresses() {
                        let url = format!("http://{}:{}", ip, info.get_port());
                        if !results.contains(&url) {
                            results.push(url);
                        }
                    }
                }
            }
            _ => break,
        }
    }

    let _ = mdns.shutdown();
    results
}
