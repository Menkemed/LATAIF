#[cfg(windows)]
mod printing;
mod sync;

use std::sync::atomic::{AtomicBool, Ordering};
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

/// M6-B2A2 — der manuelle Stop ist eine Owner-Aktion.
///
/// Vorher konnte jeder Renderer den Primary-Server der Filiale abschalten. Der INTERNE
/// Shutdown (M4-D `finalize_application_shutdown`) ruft `server.stop()` direkt in Rust und
/// ist davon nicht betroffen — er braucht keine Credentials und aendert keine Rolle.
///
/// Der Stop veraendert `primary_host_config` NICHT: das Geraet bleibt primary und startet
/// beim naechsten Mal wieder korrekt.
#[tauri::command]
async fn sync_server_stop(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
) -> Result<String, String> {
    let (conn, _id) = open_config_db(&state.server)?;
    sync::primary::authorize_owner(&conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    drop(conn);
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

// ── M6-B2A — explicit static primary ────────────────────────────────────────
//
// The role now lives in the server DB, bound to this installation's id file — NOT in
// localStorage, which the client can rewrite and which cannot survive as an authority
// source. These commands are the only way the role ever changes; discovery cannot.

/// Open the server DB (creating/migrating it if needed) purely to read or write the role.
/// Kept separate from `SyncServer::start` so a client/unconfigured device can be asked
/// about its state without anything binding a port.
fn open_config_db(
    server: &sync::SyncServer,
) -> Result<(rusqlite::Connection, String), String> {
    let conn = sync::db::init_database(&server.db_path).map_err(|e| format!("DB init failed: {e}"))?;
    let id = sync::install_id::load_or_create(&server.db_path)
        .map_err(|e| format!("Install id unavailable: {e}"))?;
    Ok((conn, id))
}

#[tauri::command]
async fn primary_status(state: tauri::State<'_, AppHandleState>) -> Result<serde_json::Value, String> {
    let (conn, id) = open_config_db(&state.server)?;
    let cfg = sync::primary::load_config(&conn, "tenant-1", "branch-main")
        .map_err(|e| format!("Primary config unreadable: {e}"))?;
    let resolved = sync::primary::resolve_state(cfg.as_ref(), &id);
    Ok(serde_json::json!({
        "state": resolved.as_str(),
        "mode": cfg.as_ref().map(|c| c.mode.as_str()).unwrap_or("unconfigured"),
        "configured": cfg.is_some(),
        "mayWriteSync": resolved.may_write_sync(),
        "shouldServe": resolved.should_serve(),
        // Redacted on purpose: the full install id is a stable device identifier.
        "installIdShort": sync::install_id::redact(&id),
        "instanceMatches": cfg
            .as_ref()
            .and_then(|c| c.server_instance_id.as_deref())
            .map(|b| b == id),
    }))
}

/// Explicit, OWNER-AUTHORIZED action: set this installation's role. The only path that
/// ever writes `mode='primary'`, and it always binds to this install's id.
///
/// M6-B2A1 — why credentials: a Tauri command arrives from the renderer, and there is no
/// Rust-side session. A role or a `configured_by` passed in would be the caller vouching
/// for itself; a JWT would not help either, since the self-token carries `role="owner"`
/// and is handed to that same renderer. Only knowledge of the owner password — checked
/// against the bcrypt hash in the SERVER DB — is a boundary the renderer cannot cross by
/// itself. `configured_by` then comes from the verified lookup, never from the call.
#[tauri::command]
async fn primary_configure(
    state: tauri::State<'_, AppHandleState>,
    mode: String,
    email: String,
    password: String,
) -> Result<serde_json::Value, String> {
    let m = sync::primary::Mode::parse(&mode).ok_or_else(|| format!("unknown mode '{mode}'"))?;
    let (conn, id) = open_config_db(&state.server)?;

    let owner = sync::primary::authorize_owner(&conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;

    let applied = sync::primary::configure_as_owner(&conn, "tenant-1", "branch-main", m, &id, &owner)
        .map_err(|code| code.to_string())?;

    Ok(serde_json::json!({ "mode": applied.as_str(), "configuredBy": owner.user_id() }))
}

/// M6-B2A2 — der einzige Weg von einem Legacy-Hinweis zu `primary`.
///
/// Verlangt verifizierte Owner-Credentials UND die woertliche Bestaetigung. Der Grund:
/// `lataif_lan_mode='server'` und die Changelog-Historie sind beide **kopierbar** — eine
/// Vor-v0002-Server-DB traegt echte Historie und keine Bindung, also wuerde jede Kopie
/// sich sonst an ihre neue Installation binden. Erst diese Erklaerung des Owners macht
/// aus einer Spur eine Rolle.
#[tauri::command]
async fn primary_adopt_legacy(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
    confirmation: String,
) -> Result<serde_json::Value, String> {
    let (conn, id) = open_config_db(&state.server)?;
    let owner = sync::primary::authorize_owner(&conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    let m = sync::primary::adopt_legacy_as_owner(
        &conn,
        "tenant-1",
        "branch-main",
        &id,
        &owner,
        &confirmation,
    )
    .map_err(|code| code.to_string())?;
    Ok(serde_json::json!({ "mode": m.as_str(), "adoptedBy": owner.user_id() }))
}

/// One-time adoption of the legacy `lataif_lan_mode` / `lataif_lan_setup_done` values.
/// Idempotent: once a row exists the legacy values are ignored forever, so a stale or
/// cleared localStorage can never re-decide the role.
#[tauri::command]
async fn primary_migrate_legacy(
    state: tauri::State<'_, AppHandleState>,
    legacy_mode: Option<String>,
    setup_done: bool,
) -> Result<serde_json::Value, String> {
    let (conn, id) = open_config_db(&state.server)?;
    let legacy = sync::primary::LegacyLanConfig { mode: legacy_mode, setup_done };
    let m = sync::primary::migrate_once(&conn, "tenant-1", "branch-main", &legacy, &id)
        .map_err(|e| format!("Legacy migration failed: {e}"))?;
    Ok(serde_json::json!({ "mode": m.as_str() }))
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
// M4-D — Native Close Finalization (nach durablem Frontend-Flush)
// ═══════════════════════════════════════════════════════════════════════════
//
// Ausgangslage (M4-C, empirisch belegt): der alte Close-Pfad rief im Webview `win.destroy()`
// (in Tauri v2 mangels `core:window:allow-destroy` still abgelehnt) und beendete den Prozess
// dann NUR ueber einen Webview-`setTimeout(2000) → proc.exit(0)`-Fallback. Wird der Webview
// suspendiert/okkludiert (minimiert), laeuft dieser JS-Timer nicht mehr → der Prozess terminiert
// nicht, Port 3001 bleibt belegt.
//
// Loesung: den finalen Prozess-Exit NICHT an einen Webview-Timer koppeln. Das Frontend ruft NACH
// bestaetigter durabler Persistenz genau diesen Command; ab hier uebernimmt Rust nativ: den
// eingebetteten Sync-Server idempotent stoppen (Port 3001 freigeben) und `AppHandle::exit(0)`.
// Der Finalizer fuehrt bewusst KEINE DB-/Persistenzoperation aus (die liegt vollstaendig im
// Frontend/M2/M4) und loggt keine Geschaeftsdaten.

// Idempotenz-Guard: der Shutdown-Finalizer darf pro Prozess nur EINMAL wirken (schneller Doppel-X
// bzw. doppelter invoke → kein zweiter Server-Stop, kein zweiter Exit).
static SHUTDOWN_STARTED: AtomicBool = AtomicBool::new(false);

mod shutdown {
    use std::time::Duration;

    /// Reiner, injizierbarer Finalisierungs-Ablauf — ohne Tauri und ohne echten Prozess-Exit,
    /// damit Reihenfolge (Server-Stop VOR Exit), Idempotenz und Timeout-Verhalten unit-testbar sind.
    ///
    ///   proceed == false → Doppelaufruf: NICHTS tun (kein zweiter Stop, kein zweiter Exit).
    ///   sonst            → Sync-Server stoppen (mit hartem Zeitdeckel) → danach exit_application() 1×.
    ///
    /// Der Zeitdeckel garantiert, dass ein haengender/fehlerhafter Server-Stop den nativen Exit
    /// NIEMALS blockiert: der Frontend-Flush ist zu diesem Zeitpunkt bereits durabel bestaetigt, es
    /// darf nichts mehr die Terminierung offenhalten. Ein Timeout ist KEIN Fehler.
    /// Es gibt bewusst keinen DB-/Persistenz-Parameter — der Ablauf kann gar nichts speichern.
    pub async fn finalize_shutdown_sequence<S, F>(
        proceed: bool,
        stop_timeout: Duration,
        stop_server: S,
        exit_application: F,
    ) -> bool
    where
        S: std::future::Future<Output = ()>,
        F: FnOnce(),
    {
        if !proceed {
            return false;
        }
        // Server-Stop mit Deckel — bei Timeout ODER Erfolg geht es zum Exit (Ergebnis egal).
        let _ = tokio::time::timeout(stop_timeout, stop_server).await;
        exit_application();
        true
    }
}

// M4-D — Nativer Close-Finalizer. Das Frontend ruft diesen Command AUSSCHLIESSLICH nach einem
// erfolgreich bestaetigten durablen DB-Flush (prepareAndCloseApplication). Terminierung liegt
// damit nativ bei Rust statt an einem fragilen Webview-Timer.
#[tauri::command]
async fn finalize_application_shutdown(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppHandleState>,
) -> Result<(), String> {
    // Idempotenz gegen Doppel-X: nur der erste Aufruf wirkt (atomarer compare_exchange).
    let proceed = SHUTDOWN_STARTED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok();
    // Arc/Handle vor dem await klonen — kein State-Borrow ueber den await-Punkt.
    let server = state.server.clone();
    let app_handle = app.clone();
    shutdown::finalize_shutdown_sequence(
        proceed,
        std::time::Duration::from_secs(3),
        // Server-Stop ist idempotent (SyncServer::stop → Ok bei "nicht laufend"); Fehler/Timeout
        // duerfen den Exit nicht blockieren → Ergebnis bewusst verworfen.
        async move {
            let _ = server.stop().await;
        },
        move || app_handle.exit(0),
    )
    .await;
    Ok(())
}

#[cfg(test)]
mod shutdown_tests {
    use super::shutdown::finalize_shutdown_sequence;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    // Hinweis "keine DB-Operation": der Helper hat gar keinen DB-/Persistenz-Parameter — er KANN
    // strukturell nichts speichern. Diese Tests decken Reihenfolge, Idempotenz und Timeout ab.

    #[tokio::test]
    async fn stops_server_before_exit_when_running() {
        // Gemeinsames Reihenfolge-Log → "stop" muss vor "exit" stehen.
        let log = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        let l1 = log.clone();
        let l2 = log.clone();
        let ran = finalize_shutdown_sequence(
            true,
            Duration::from_secs(1),
            async move {
                l1.lock().unwrap().push("stop");
            },
            move || l2.lock().unwrap().push("exit"),
        )
        .await;
        assert!(ran, "Finalisierung soll ausgefuehrt werden");
        assert_eq!(*log.lock().unwrap(), vec!["stop", "exit"]);
    }

    #[tokio::test]
    async fn exits_even_when_server_not_running() {
        // "Server nicht laufend" ist im echten Code ein Ok-Stop; hier tut der Stop-Future nichts.
        let exited = Arc::new(AtomicUsize::new(0));
        let e = exited.clone();
        let ran = finalize_shutdown_sequence(
            true,
            Duration::from_secs(1),
            async move { /* no-op: Server war nicht aktiv */ },
            move || {
                e.fetch_add(1, Ordering::SeqCst);
            },
        )
        .await;
        assert!(ran);
        assert_eq!(exited.load(Ordering::SeqCst), 1, "Exit auch ohne laufenden Server");
    }

    #[tokio::test]
    async fn double_call_does_nothing() {
        // proceed == false (zweiter invoke / Doppel-X) → weder Stop noch Exit.
        let stop = Arc::new(AtomicUsize::new(0));
        let exit = Arc::new(AtomicUsize::new(0));
        let s = stop.clone();
        let e = exit.clone();
        let ran = finalize_shutdown_sequence(
            false,
            Duration::from_secs(1),
            async move {
                s.fetch_add(1, Ordering::SeqCst);
            },
            move || {
                e.fetch_add(1, Ordering::SeqCst);
            },
        )
        .await;
        assert!(!ran);
        assert_eq!(stop.load(Ordering::SeqCst), 0, "kein zweiter Server-Stop");
        assert_eq!(exit.load(Ordering::SeqCst), 0, "kein zweiter Exit");
    }

    #[tokio::test]
    async fn hanging_stop_times_out_then_exits() {
        // Haengender Server-Stop → Timeout greift → Exit passiert trotzdem, ohne lange zu warten.
        let exit = Arc::new(AtomicUsize::new(0));
        let e = exit.clone();
        let start = Instant::now();
        let ran = finalize_shutdown_sequence(
            true,
            Duration::from_millis(50),
            std::future::pending::<()>(), // Stop, der NIE fertig wird
            move || {
                e.fetch_add(1, Ordering::SeqCst);
            },
        )
        .await;
        assert!(ran);
        assert_eq!(exit.load(Ordering::SeqCst), 1, "Exit trotz haengendem Stop");
        assert!(start.elapsed() >= Duration::from_millis(50), "Timeout muss abgelaufen sein");
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "Exit darf nicht auf den haengenden Stop warten"
        );
    }

    #[tokio::test]
    async fn exit_called_exactly_once() {
        let exit = Arc::new(AtomicUsize::new(0));
        let e = exit.clone();
        finalize_shutdown_sequence(
            true,
            Duration::from_secs(1),
            async move {},
            move || {
                e.fetch_add(1, Ordering::SeqCst);
            },
        )
        .await;
        assert_eq!(exit.load(Ordering::SeqCst), 1, "Exit-Callback genau einmal");
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
            primary_status,
            primary_configure,
            primary_adopt_legacy,
            primary_migrate_legacy,
            sync_server_stop,
            sync_server_status,
            discover_lan_servers,
            print_raw_zpl,
            finalize_application_shutdown
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
