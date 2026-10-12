// ════════════════════════════════════════════════════════════════════════════
// INSTANCE-LOCK — höchstens EIN LATAIF-Prozess je Anwendung und Windows-Benutzer.
//
// Vorfall (12.10.2026, Primary): zwei Fenster arbeiteten stundenlang auf derselben lataif.db. Das eine
// speicherte, das andere durfte danach nichts mehr speichern (stale-write guard) und war beim Schließen
// nicht mehr zu beenden.
//
// Warum der vorhandene Schutz (tauri-plugin-single-instance 2.4.3) das nicht verhinderte — aus seinem
// Quelltext (platform_impl/windows.rs): Meldet `CreateMutexW` „gibt es schon", sucht die zweite Kopie
// das unsichtbare Nachrichtenfenster der ersten (`FindWindowW`). NUR wenn sie es findet, schickt sie
// ihre Argumente und beendet sich. Findet sie es nicht (die erste ist gerade erst beim Starten, beim
// Beenden, oder ihr Fenster fehlt), läuft sie einfach WEITER — als vollwertige zweite Kopie.
//
// Diese Sperre schließt die Lücke ohne Ausnahme: eine Datei, die der laufende Prozess EXKLUSIV offen
// hält (Freigabemodus 0). Windows verweigert jedem weiteren Öffnen `ERROR_SHARING_VIOLATION`, solange
// der Prozess lebt, und gibt sie frei, sobald er endet — auch nach einem Absturz. Keine Sperre bleibt
// liegen, nichts muss aufgeräumt werden.
//
// Ort: das identifier-eigene LOKALE AppData (`%LOCALAPPDATA%\com.lataif.app`). NICHT der Kontroll-
// ordner (dort entscheidet ein LEERER Ordner über den Erststart) und NICHT der Datenordner (Umzug,
// Übernahme und Backup lesen ihn) — die Sperrdatei verändert keine dieser Entscheidungen. Die
// E2E-Builds haben eigene Identifier und damit eigene Sperren.
// ════════════════════════════════════════════════════════════════════════════
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const LOCK_FILE_NAME: &str = ".lataif-instance.lock";

/// Wie lange eine neue Kopie auf die Freigabe wartet. Beim Neustart (Update, Wiederherstellung) startet
/// die neue Kopie, während die alte noch ausläuft — sie soll warten, nicht aufgeben.
pub const RELAUNCH_WAIT: Duration = Duration::from_secs(10);
pub const RETRY_STEP: Duration = Duration::from_millis(250);

/// Solange dieser Wert lebt, ist die Sperre gehalten. Fallenlassen gibt sie frei.
#[derive(Debug)]
pub struct InstanceLock {
    _file: std::fs::File,
    path: PathBuf,
}

impl InstanceLock {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum LockError {
    /// Ein anderer Prozess hält die Sperre — es läuft schon eine Kopie.
    HeldByAnotherProcess,
    /// Die Sperrdatei ließ sich nicht anlegen (kein Beweis für eine zweite Kopie).
    Io(String),
}

pub fn lock_path(dir: &Path) -> PathBuf {
    dir.join(LOCK_FILE_NAME)
}

/// Ein Versuch, ohne Warten.
pub fn try_acquire(dir: &Path) -> Result<InstanceLock, LockError> {
    std::fs::create_dir_all(dir).map_err(|e| LockError::Io(e.to_string()))?;
    let path = lock_path(dir);
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true).write(true).create(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        opts.share_mode(0);
    }
    match opts.open(&path) {
        Ok(file) => Ok(InstanceLock { _file: file, path }),
        Err(e) if is_held(&e) => Err(LockError::HeldByAnotherProcess),
        Err(e) => Err(LockError::Io(e.to_string())),
    }
}

#[cfg(windows)]
fn is_held(e: &std::io::Error) -> bool {
    const ERROR_SHARING_VIOLATION: i32 = 32;
    const ERROR_LOCK_VIOLATION: i32 = 33;
    matches!(e.raw_os_error(), Some(ERROR_SHARING_VIOLATION) | Some(ERROR_LOCK_VIOLATION))
}

// Ausgeliefert wird nur für Windows. Anderswo gibt es keinen Freigabemodus — die Sperre greift dort nicht.
#[cfg(not(windows))]
fn is_held(_e: &std::io::Error) -> bool {
    false
}

/// Versucht es bis `wait` lang erneut, solange ein anderer Prozess die Sperre hält.
pub fn acquire_waiting(dir: &Path, wait: Duration, step: Duration) -> Result<InstanceLock, LockError> {
    let deadline = Instant::now() + wait;
    loop {
        match try_acquire(dir) {
            Err(LockError::HeldByAnotherProcess) if Instant::now() < deadline => std::thread::sleep(step),
            other => return other,
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lataif-instance-lock-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn first_holds_second_is_refused_and_release_frees_it() {
        let d = tmp("basic");
        let first = try_acquire(&d).expect("first copy gets the lock");
        assert!(first.path().ends_with(LOCK_FILE_NAME));
        assert_eq!(try_acquire(&d).unwrap_err(), LockError::HeldByAnotherProcess, "second copy is refused");
        drop(first);
        let again = try_acquire(&d).expect("after the first ends, a new copy gets the lock");
        drop(again);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_directory_is_created() {
        let d = tmp("mkdir").join("nested");
        let lock = try_acquire(&d).expect("lock in a directory that did not exist yet");
        assert!(lock.path().exists());
        drop(lock);
        let _ = std::fs::remove_dir_all(d.parent().unwrap());
    }

    #[test]
    fn relaunch_waits_until_the_old_copy_is_gone() {
        let d = tmp("relaunch");
        let old = try_acquire(&d).unwrap();
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            drop(old);
        });
        let started = Instant::now();
        let new = acquire_waiting(&d, Duration::from_secs(5), Duration::from_millis(50)).expect("new copy waits and then gets it");
        assert!(started.elapsed() >= Duration::from_millis(350), "it really waited for the old copy");
        releaser.join().unwrap();
        drop(new);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_copy_that_keeps_running_is_reported_after_the_wait() {
        let d = tmp("held");
        let running = try_acquire(&d).unwrap();
        let started = Instant::now();
        let r = acquire_waiting(&d, Duration::from_millis(300), Duration::from_millis(50));
        assert_eq!(r.unwrap_err(), LockError::HeldByAnotherProcess);
        assert!(started.elapsed() >= Duration::from_millis(300), "it waited the full time before giving up");
        drop(running);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn startup_takes_the_lock_first_and_refuses_a_second_copy() {
        let lib = include_str!("lib.rs");
        let setup = lib.find(".setup(|app| {").expect("setup closure");
        let lock = lib[setup..].find("instance_lock::acquire_waiting(").map(|i| i + setup).expect("setup takes the instance lock");
        let first_run = lib.find("data_root::resolve_or_first_run(&locator_dir)").expect("first-run check");
        let plugin = lib.find("tauri_plugin_single_instance::init(").expect("single-instance plugin stays");
        assert!(plugin < setup && lock < first_run, "lock is taken in setup BEFORE any data-root decision, DB or server");
        let block = &lib[setup..first_run];
        assert!(block.contains("LockError::HeldByAnotherProcess") && block.contains("std::process::exit(0)"),
            "a second copy is told and exits before it touches anything");
        assert!(block.contains("app_local_data_dir()"), "the lock lives in the local AppData, not in the control or data folder");
        assert!(block.contains("app.manage(InstanceLockState("), "the lock is held for the life of the process");
    }
}
