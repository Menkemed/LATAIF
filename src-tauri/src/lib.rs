#[cfg(windows)]
mod printing;
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
async fn sync_server_status(
    state: tauri::State<'_, AppHandleState>,
) -> Result<serde_json::Value, String> {
    let (running, port, self_token) = state.server.status().await;
    let ip = local_ip_address::local_ip()
        .map(|i| i.to_string())
        .unwrap_or_else(|_| "0.0.0.0".into());
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

// Raw-Druck von ZPL an einen benannten Drucker (Zebra-Tags). Windows-only;
// auf anderen Plattformen ein sauberer Fehler statt Compile-Bruch.
#[tauri::command]
fn print_raw_zpl(printer: String, zpl: String) -> Result<u32, String> {
    #[cfg(windows)]
    {
        printing::print_raw(&printer, zpl.as_bytes())
    }
    #[cfg(not(windows))]
    {
        let _ = (printer, zpl);
        Err("Raw-Druck wird nur unter Windows unterstützt.".to_string())
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// M5-B — Native WebView2 Reload-Accelerator-Bridge (F5 / Ctrl+R)
// ═══════════════════════════════════════════════════════════════════════════
//
// Ausgangslage (empirisch belegt in M5-A1): Ein reiner JS-`keydown`-Interceptor mit
// preventDefault() kann den nativen WebView2-Reload NICHT verhindern — WebView2 feuert den
// Reload-Accelerator auf COM-Ebene, bevor/statt der DOM-keydown das Frontend erreicht.
//
// Loesung (gezielt, NICHT global): Auf dem ICoreWebView2Controller einen AcceleratorKeyPressed-
// Handler registrieren. NUR fuer F5 und Ctrl+R setzen wir SetHandled(true) → der native Reload
// unterbleibt. Danach melden wir den Reload-Wunsch als Tauri-Event ans Frontend, das den
// bestehenden M5-Flow faehrt (Sync pausieren → abwarten → durabel speichern → kontrolliert
// reloaden). Alle anderen Accelerator (Ctrl+F, Ctrl+P, F12, Zoom, …) bleiben voellig unberuehrt.

// Event-Name — muss exakt mit src/App.tsx (NATIVE_RELOAD_EVENT) uebereinstimmen.
#[cfg(windows)]
const NATIVE_RELOAD_EVENT: &str = "m5-native-reload-requested";

// Windows Virtual-Key-Codes (nur die fuer die Reload-Klassifikation benoetigten).
#[cfg(windows)]
const VK_F5_CODE: u32 = 0x74; // VK_F5
#[cfg(windows)]
const VK_R_CODE: u32 = 0x52; // 'R'

/// Reine, testbare Klassifikation: Ist dieses native Tastenereignis ein Reload-Accelerator
/// (F5 oder Ctrl+R), den wir abfangen und durch den M5-Flow leiten wollen?
///
/// Bewusste Entscheidungen (dokumentiert):
///   F5 (auch Ctrl+F5 / Shift+F5)  → true   — Hard-Reload ist ebenfalls ein Reload
///   Ctrl+R / Ctrl+Shift+R         → true   — Shift = Hard-Reload, trotzdem ein Reload
///   R ohne Ctrl                   → false
///   Ctrl+F / Ctrl+P / F3 / F12    → false  — kein Reload, unberuehrt lassen
///   Alt+irgendetwas               → false  — System-/Menue-Kombinationen nie abfangen
///   KeyUp                         → false  — nur der KeyDown loest aus
#[cfg(windows)]
fn is_reload_accelerator(
    virtual_key: u32,
    is_key_down: bool,
    ctrl: bool,
    alt: bool,
    _shift: bool,
) -> bool {
    if !is_key_down {
        return false;
    }
    if alt {
        return false;
    }
    if virtual_key == VK_F5_CODE {
        return true;
    }
    if virtual_key == VK_R_CODE && ctrl {
        return true;
    }
    false
}

#[cfg(windows)]
mod reload_bridge {
    use super::{is_reload_accelerator, NATIVE_RELOAD_EVENT};
    use tauri::{AppHandle, Emitter, WebviewWindow};
    use webview2_com::AcceleratorKeyPressedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
        COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN, COREWEBVIEW2_PHYSICAL_KEY_STATUS,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetKeyState, VIRTUAL_KEY, VK_CONTROL, VK_MENU, VK_SHIFT,
    };

    // GetKeyState: High-Bit (0x8000) gesetzt = Taste ist aktuell gedrueckt.
    #[inline]
    fn key_is_down(vk: VIRTUAL_KEY) -> bool {
        (unsafe { GetKeyState(vk.0 as i32) } as u16 & 0x8000) != 0
    }

    /// Registriert den AcceleratorKeyPressed-Handler auf dem Main-Webview-Controller.
    /// Der Handler laeuft auf dem Webview-(UI-)Thread. add_AcceleratorKeyPressed haelt den
    /// Handler per AddRef fuer die gesamte Controller-Lebenszeit am Leben — der Token wird nur
    /// zum spaeteren Entfernen gebraucht und hier bewusst verworfen. Fehler werden geloggt
    /// (kein unwrap/Panic), damit die App auch ohne Bruecke normal startet.
    pub fn install(window: &WebviewWindow, app: AppHandle) {
        let res = window.with_webview(move |pw| {
            let controller = pw.controller();
            let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else { return Ok(()) };

                let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
                unsafe { args.KeyEventKind(&mut kind)? };
                let mut virtual_key: u32 = 0;
                unsafe { args.VirtualKey(&mut virtual_key)? };

                let is_key_down = kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                    || kind == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN;
                let ctrl = key_is_down(VK_CONTROL);
                let alt = key_is_down(VK_MENU);
                let shift = key_is_down(VK_SHIFT);

                if is_reload_accelerator(virtual_key, is_key_down, ctrl, alt, shift) {
                    // 1) Nativen Browser-Reload unterdruecken — das ist der eigentliche Fix.
                    unsafe { args.SetHandled(true)? };
                    // 2) Auto-Repeat (gehaltene Taste) erzeugt KEINE zweite Kette: nur beim ersten
                    //    KeyDown ein Event senden. WasKeyDown == true → Wiederholung → nichts senden.
                    let mut status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
                    unsafe { args.PhysicalKeyStatus(&mut status)? };
                    if !status.WasKeyDown.as_bool() {
                        // 3) Reload-Wunsch ans Frontend (M5-Flow entscheidet ueber den Reload).
                        let _ = app.emit(NATIVE_RELOAD_EVENT, ());
                    }
                }
                Ok(())
            }));

            let mut token: i64 = 0;
            match unsafe { controller.add_AcceleratorKeyPressed(&handler, &mut token) } {
                Ok(()) => eprintln!("[m5-reload-bridge] installed — F5/Ctrl+R are controlled"),
                Err(e) => eprintln!("[m5-reload-bridge] add_AcceleratorKeyPressed failed: {e:?}"),
            }
        });
        if let Err(e) = res {
            eprintln!("[m5-reload-bridge] with_webview failed: {e:?}");
        }
    }
}

#[cfg(all(test, windows))]
mod reload_bridge_tests {
    use super::is_reload_accelerator;

    // Virtual-Key-Codes fuer die Testfaelle.
    const VK_F5: u32 = 0x74;
    const VK_R: u32 = 0x52;
    const VK_F: u32 = 0x46;
    const VK_P: u32 = 0x50;
    const VK_F3: u32 = 0x72;
    const VK_F12: u32 = 0x7B;

    #[test]
    fn f5_keydown_is_reload() {
        assert!(is_reload_accelerator(VK_F5, true, false, false, false));
    }

    #[test]
    fn ctrl_r_keydown_is_reload() {
        assert!(is_reload_accelerator(VK_R, true, true, false, false));
    }

    #[test]
    fn ctrl_shift_r_is_reload() {
        // Ctrl+Shift+R (Hard-Reload) wird bewusst ebenfalls als Reload behandelt.
        assert!(is_reload_accelerator(VK_R, true, true, false, true));
    }

    #[test]
    fn ctrl_f5_is_reload() {
        // Ctrl+F5 (Hard-Reload) ebenfalls Reload.
        assert!(is_reload_accelerator(VK_F5, true, true, false, false));
    }

    #[test]
    fn r_without_ctrl_is_not_reload() {
        assert!(!is_reload_accelerator(VK_R, true, false, false, false));
    }

    #[test]
    fn ctrl_f_is_not_reload() {
        assert!(!is_reload_accelerator(VK_F, true, true, false, false));
    }

    #[test]
    fn ctrl_p_is_not_reload() {
        assert!(!is_reload_accelerator(VK_P, true, true, false, false));
    }

    #[test]
    fn f3_is_not_reload() {
        assert!(!is_reload_accelerator(VK_F3, true, false, false, false));
    }

    #[test]
    fn f12_is_not_reload() {
        assert!(!is_reload_accelerator(VK_F12, true, false, false, false));
    }

    #[test]
    fn keyup_is_never_reload() {
        // Gleiche Tasten, aber KeyUp → nie ausloesen (nur KeyDown loest aus).
        assert!(!is_reload_accelerator(VK_F5, false, false, false, false));
        assert!(!is_reload_accelerator(VK_R, false, true, false, false));
    }

    #[test]
    fn alt_combinations_are_never_reload() {
        // Alt+R / Alt+F5 → nie abfangen (System-/Menuekombination).
        assert!(!is_reload_accelerator(VK_R, true, true, true, false));
        assert!(!is_reload_accelerator(VK_F5, true, false, true, false));
    }

    #[test]
    fn repeat_same_state_stays_deterministic() {
        // Repeat-Unterdrueckung passiert im nativen Handler (WasKeyDown), nicht im Klassifikator:
        // fuer denselben Tastenzustand bleibt die Klassifikation deterministisch true.
        assert!(is_reload_accelerator(VK_R, true, true, false, false));
        assert!(is_reload_accelerator(VK_R, true, true, false, false));
    }
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

            // M5-B — native WebView2-Reload-Bruecke (nur Windows) auf dem Main-Webview
            // installieren: F5/Ctrl+R nativ unterdruecken und als Tauri-Event ans Frontend
            // melden, das den durablen M5-Save-vor-Reload-Flow faehrt.
            #[cfg(windows)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    reload_bridge::install(&window, app.handle().clone());
                } else {
                    eprintln!("[m5-reload-bridge] main webview window not found — bridge not installed");
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sync_server_start,
            sync_server_stop,
            sync_server_status,
            discover_lan_servers,
            print_raw_zpl
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
