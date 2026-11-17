//! A2-WARTUNG — Startsperre für eine OFFLINE-Wartung des Datenordners (z. B.
//! `scripts/maint/changelog-schlankung.mjs`).
//!
//! Anders als der Wartungsmodus in `maintenance.rs` (nur im Speicher, endet mit jedem Neustart) läuft eine
//! Offline-Wartung, während die App GESCHLOSSEN ist, und ändert beide Datenbanken nacheinander. Bricht sie ab
//! (Absturz, Stromausfall), darf die App nicht auf einem halb gewarteten Stand starten — und vor allem keinen
//! Sync-Server öffnen, über den PC2 oder das Handy schreiben könnten.
//!
//! Das Signal ist eine Datei im Datenordner: `WARTUNG-LAEUFT.lock`. Das Werkzeug legt sie VOR dem ersten
//! Schreiben exklusiv an und entfernt sie erst, nachdem der Gesamtnachweis bestanden ist (oder über
//! `freigeben` nach geprüftem Zustand). Ein Zurückspielen des Sicherungssatzes ersetzt den Datenordner und
//! damit auch die Sperre. Ein Absturz entfernt sie nie.
//!
//! Beim Start (lib.rs, `setup`): unmittelbar nach dem Auflösen des Datenorts — vor Aufräumen, Restore-
//! Recovery, geplantem Restore/Backup, Staging-GC, jeder Datenbank, dem Sync-/Mobile-Server und dem Fenster-
//! inhalt. Fail-closed: lässt sich nicht feststellen, ob die Datei existiert, gilt das als gesperrt.

use std::path::Path;

/// Name der Sperrdatei im Datenordner.
pub const LOCK_FILENAME: &str = "WARTUNG-LAEUFT.lock";

#[derive(Debug, PartialEq, Eq)]
pub enum MaintenanceState {
    /// Keine Offline-Wartung offen.
    Free,
    /// Sperre vorhanden (oder ihr Zustand nicht feststellbar) — mit kurzer, protokollsicherer Angabe.
    Locked(String),
}

/// Liegt im Datenordner eine Offline-Wartungssperre?
pub fn state(data_root: &Path) -> MaintenanceState {
    let p = data_root.join(LOCK_FILENAME);
    match std::fs::symlink_metadata(&p) {
        Ok(_) => {
            // Nur der Stand aus der Datei („vorbereitung", „laeuft", …) — nie Pfade oder Inhalte weitergeben.
            let stand = std::fs::read_to_string(&p)
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| v.get("stand").and_then(|x| x.as_str()).map(|x| x.to_string()))
                .filter(|s| s.len() <= 40 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
                .unwrap_or_else(|| "unbekannt".to_string());
            MaintenanceState::Locked(format!("stand={stand}"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => MaintenanceState::Free,
        Err(e) => MaintenanceState::Locked(format!("lock state unreadable: {}", e.kind())),
    }
}

/// Der Satz für den Menschen (Startabbruch).
pub const BLOCKING_MESSAGE: &str = "A data maintenance run on this computer is in progress or was interrupted.\n\n\
LATAIF does not start until it is finished, so that no window, phone or second PC can work on half-maintained data.\n\n\
Finish it with the maintenance tool (\"fortsetzen\" or \"freigeben\"), or restore the backup set that was taken before it.";

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("lataif-maint-lock-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn free_without_file() {
        let d = tmp("free");
        assert_eq!(state(&d), MaintenanceState::Free);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn locked_with_file_and_reports_only_the_stage() {
        let d = tmp("held");
        std::fs::write(d.join(LOCK_FILENAME), r#"{"werkzeug":"changelog-schlankung/1","stand":"laeuft","journal":"C:\\secret\\x.json"}"#).unwrap();
        assert_eq!(state(&d), MaintenanceState::Locked("stand=laeuft".into()));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn locked_even_when_empty_or_garbled() {
        // Ein Absturz mitten im Anlegen kann eine leere oder halbe Datei hinterlassen — sie sperrt trotzdem.
        let d = tmp("garbled");
        std::fs::write(d.join(LOCK_FILENAME), "").unwrap();
        assert_eq!(state(&d), MaintenanceState::Locked("stand=unbekannt".into()));
        std::fs::write(d.join(LOCK_FILENAME), "{\"stand\":\"x y/../z\"").unwrap();
        assert_eq!(state(&d), MaintenanceState::Locked("stand=unbekannt".into()));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn locked_when_the_name_is_a_directory() {
        let d = tmp("dir");
        std::fs::create_dir_all(d.join(LOCK_FILENAME)).unwrap();
        assert!(matches!(state(&d), MaintenanceState::Locked(_)));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn startup_checks_the_lock_before_any_recovery_database_or_server() {
        let src = include_str!("lib.rs");
        let lock = src.find("maintenance_lock::state(").expect("lib.rs checks the maintenance lock");
        for later in [
            "data_root_move::cleanup_stale_control_copies(",
            "media::restore_recovery::recover(",
            "media::restore::execute_pending_restore(",
            "media::backup::execute_pending_backup(",
        ] {
            let at = src.find(later).unwrap_or_else(|| panic!("{later} not found in lib.rs"));
            assert!(lock < at, "maintenance lock must be checked before {later}");
        }
        let root = src.find("data_root_move::resolve_with_pending_move(&locator_dir)").expect("data root resolution");
        assert!(root < lock, "the lock lives in the resolved data root");
    }
}
