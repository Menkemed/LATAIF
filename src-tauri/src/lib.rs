mod sync;

use std::sync::Arc;
use tauri::Manager;

struct AppHandleState {
    server: Arc<sync::SyncServer>,
}

const SYNC_PORT: u16 = 3001;

#[tauri::command]
async fn sync_server_start(state: tauri::State<'_, AppHandleState>) -> Result<String, String> {
    state.server.start().await
}

#[tauri::command]
async fn sync_server_stop(state: tauri::State<'_, AppHandleState>) -> Result<String, String> {
    state.server.stop().await
}

#[tauri::command]
async fn sync_server_status(state: tauri::State<'_, AppHandleState>) -> Result<serde_json::Value, String> {
    let (running, port, self_token) = state.server.status().await;
    let ip = local_ip_address::local_ip().map(|i| i.to_string()).unwrap_or_else(|_| "0.0.0.0".into());
    Ok(serde_json::json!({
        "running": running,
        "port": port,
        "ip": ip,
        "url": if running { format!("http://{}:{}", ip, port) } else { String::new() },
        // Self-Token wird nur returnt wenn Server gerade laeuft. JS in autoLanSetup
        // verwendet ihn als Sync-Auth-Token (kein expliziter Login noetig).
        "selfToken": self_token,
    }))
}

#[tauri::command]
async fn discover_lan_servers(timeout_secs: Option<u64>) -> Result<Vec<String>, String> {
    Ok(sync::discover_lan_servers(timeout_secs.unwrap_or(3)).await)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let _ = std::fs::create_dir_all(&app_dir);
            let db_path = app_dir.join("lataif_sync_server.db");

            let server = Arc::new(sync::SyncServer::new(db_path, SYNC_PORT));
            app.manage(AppHandleState { server });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sync_server_start,
            sync_server_stop,
            sync_server_status,
            discover_lan_servers
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
