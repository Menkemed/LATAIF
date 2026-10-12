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
// der Prozess lebt, und gibt sie frei, sobald er endet — auch nach einem Absturz. Entscheidend ist der
// offene Griff, nicht die Datei: eine liegengebliebene Sperrdatei ohne Prozess sperrt nichts.
//
// Ort: das identifier-eigene LOKALE AppData (`%LOCALAPPDATA%\com.lataif.app`). NICHT der Kontroll-
// ordner (dort entscheidet ein LEERER Ordner über den Erststart) und NICHT der Datenordner (Umzug,
// Übernahme und Backup lesen ihn) — die Sperrdatei verändert keine dieser Entscheidungen. Die
// E2E-Builds haben eigene Identifier und damit eigene Sperren.
//
// Verhalten beim Start (lib.rs, `setup`, vor Datenort, Datenbank, Server, Handy-Verarbeitung):
//   • frei                         → Sperre nehmen und bis zum Prozessende halten (Tauri-Zustand);
//   • von einem anderen Prozess gehalten → bis `RELAUNCH_WAIT` warten (Neustart nach Update), dann
//                                    „already running" und Ende, ohne etwas zu öffnen;
//   • technisch nicht einrichtbar  → fail-closed: Sicherheitsmeldung und Ende, kein Start ohne Sperre.
//
// UMFANG — was diese Sperre schützt und was nicht:
//   • SIE SCHÜTZT: mehrere LATAIF-Prozesse DESSELBEN Windows-Benutzers (das lokale AppData gehört dem
//     Benutzer), gleich ob über Verknüpfung, Doppelklick, Neustart oder Update gestartet.
//   • SIE SCHÜTZT NICHT: zwei VERSCHIEDENE Windows-Benutzer, die denselben Datenordner öffnen (z. B.
//     `E:\LATAIF\Data`). Jeder hat sein eigenes lokales AppData und damit seine eigene Sperre. Sie ist
//     also KEINE Sperre des Datenordners und darf nicht als solche gelten.
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
    /// Die Sperre ließ sich technisch nicht einrichten (Ordner, Rechte, Datenträger …). Der Start bricht
    /// dann ab (fail-closed) — ohne Sperre ist eine zweite Kopie nicht auszuschließen.
    Io(String),
}

pub fn lock_path(dir: &Path) -> PathBuf {
    dir.join(LOCK_FILE_NAME)
}

/// Ein Versuch, ohne Warten.
pub fn try_acquire(dir: &Path) -> Result<InstanceLock, LockError> {
    std::fs::create_dir_all(dir).map_err(|e| LockError::Io(format!("{}: {e}", dir.display())))?;
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
        Err(e) => Err(LockError::Io(format!("{}: {e}", path.display()))),
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

/// Versucht es bis `wait` lang erneut, solange ein anderer Prozess die Sperre hält. Ein technischer Fehler
/// wird NICHT wiederholt, sondern sofort gemeldet.
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
    use std::process::{Child, Command, Stdio};

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lataif-instance-lock-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    // ── im selben Prozess ──────────────────────────────────────────────────

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
    fn a_leftover_lock_file_without_a_process_locks_nothing() {
        let d = tmp("leftover");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(lock_path(&d), b"left behind by a crash").unwrap();
        let lock = try_acquire(&d).expect("the file exists, but nobody holds it — the lock is free");
        drop(lock);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_technical_failure_is_an_error_not_a_free_lock_and_not_retried() {
        let d = tmp("technical");
        std::fs::create_dir_all(lock_path(&d)).unwrap(); // a FOLDER where the lock file must go
        let started = Instant::now();
        let r = acquire_waiting(&d, Duration::from_secs(5), Duration::from_millis(50));
        assert!(matches!(r, Err(LockError::Io(_))), "a lock that cannot be set up is an error (fail-closed): {r:?}");
        assert!(started.elapsed() < Duration::from_secs(2), "a technical failure is reported at once, not waited out");
        let _ = std::fs::remove_dir_all(&d);
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

    // ── getrennte Windows-Prozesse ─────────────────────────────────────────
    //
    // Jeder Kindprozess ist DIESE Testdatei als eigenes Programm, gestartet nur mit dem Helfer unten
    // (`--exact --ignored`). Er nimmt die Sperre in SEINEM Prozess und meldet das Ergebnis über eine
    // Datei. Der Elternprozess ist damit ein dritter, unabhängiger Beobachter.

    const HELPER: &str = "instance_lock::tests::child_process_lock_helper";
    const ENV_DIR: &str = "LATAIF_LOCK_CHILD_DIR";
    const ENV_MODE: &str = "LATAIF_LOCK_CHILD_MODE";
    const ENV_OUT: &str = "LATAIF_LOCK_CHILD_OUT";
    const ENV_RELEASE: &str = "LATAIF_LOCK_CHILD_RELEASE";
    const ENV_MS: &str = "LATAIF_LOCK_CHILD_MS";

    /// Ein Kindprozess, der beim Fallenlassen hart beendet wird — kein Test hinterlässt einen Prozess.
    struct Kid(Child);
    impl Drop for Kid {
        fn drop(&mut self) {
            if matches!(self.0.try_wait(), Ok(None)) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
    }

    fn spawn_kid(mode: &str, dir: &Path, out: &Path, ms: u64, release: Option<&Path>) -> Kid {
        let mut cmd = Command::new(std::env::current_exe().expect("test binary"));
        cmd.args([HELPER, "--exact", "--ignored", "--test-threads=1", "--nocapture"])
            .env(ENV_DIR, dir)
            .env(ENV_MODE, mode)
            .env(ENV_OUT, out)
            .env(ENV_MS, ms.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(r) = release {
            cmd.env(ENV_RELEASE, r);
        }
        Kid(cmd.spawn().expect("spawn child process"))
    }

    fn wait_for_report(out: &Path, timeout: Duration) -> String {
        let end = Instant::now() + timeout;
        while Instant::now() < end {
            if let Ok(s) = std::fs::read_to_string(out) {
                if !s.is_empty() {
                    return s;
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("no report from child process at {}", out.display());
    }

    fn wait_exit(kid: &mut Kid, timeout: Duration) -> std::process::ExitStatus {
        let end = Instant::now() + timeout;
        while Instant::now() < end {
            if let Some(st) = kid.0.try_wait().expect("try_wait") {
                return st;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("child process did not exit in time");
    }

    /// Der Kindprozess. Ohne die Umgebung der Eltern tut er nichts (und ist sowieso `ignore`).
    #[test]
    #[ignore = "child-process helper for the cross-process lock tests — started by them, not on its own"]
    fn child_process_lock_helper() {
        let Ok(dir) = std::env::var(ENV_DIR) else { return };
        let dir = PathBuf::from(dir);
        let out = PathBuf::from(std::env::var(ENV_OUT).expect("out"));
        let mode = std::env::var(ENV_MODE).expect("mode");
        let ms: u64 = std::env::var(ENV_MS).ok().and_then(|v| v.parse().ok()).unwrap_or(0);
        let report = |s: String| {
            let tmp = out.with_extension("tmp");
            std::fs::write(&tmp, s).unwrap();
            std::fs::rename(&tmp, &out).unwrap();
        };
        let started = Instant::now();
        let r = match mode.as_str() {
            "wait" => acquire_waiting(&dir, Duration::from_millis(ms), Duration::from_millis(50)),
            _ => try_acquire(&dir),
        };
        let word = match &r {
            Ok(_) => "acquired",
            Err(LockError::HeldByAnotherProcess) => "held",
            Err(LockError::Io(_)) => "io",
        };
        report(format!("{word} {} pid={}", started.elapsed().as_millis(), std::process::id()));
        if mode == "hold" && r.is_ok() {
            // Halten, bis die Eltern die Freigabe-Datei anlegen — oder höchstens `ms` lang (Neustart-Fall).
            let release = std::env::var(ENV_RELEASE).ok().map(PathBuf::from);
            let end = Instant::now() + Duration::from_millis(ms);
            while Instant::now() < end && !release.as_ref().is_some_and(|p| p.exists()) {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        drop(r);
    }

    #[test]
    fn separate_processes_a_holds_b_is_refused_c_takes_over() {
        let d = tmp("xproc");
        std::fs::create_dir_all(&d).unwrap();
        let release = d.join("release-a");
        // A nimmt die Sperre und bleibt am Leben.
        let mut a = spawn_kid("hold", &d.join("lock"), &d.join("a.out"), 60_000, Some(&release));
        let ra = wait_for_report(&d.join("a.out"), Duration::from_secs(30));
        assert!(ra.starts_with("acquired"), "process A holds the lock: {ra}");
        // Der Elternprozess (ein dritter) kommt ebenfalls nicht hinein.
        assert_eq!(try_acquire(&d.join("lock")).unwrap_err(), LockError::HeldByAnotherProcess, "a third process is refused too");
        // B versucht es 800 ms lang und wird abgewiesen.
        let mut b = spawn_kid("wait", &d.join("lock"), &d.join("b.out"), 800, None);
        assert!(wait_exit(&mut b, Duration::from_secs(30)).success());
        let rb = wait_for_report(&d.join("b.out"), Duration::from_secs(5));
        let waited: u64 = rb.split_whitespace().nth(1).and_then(|v| v.parse().ok()).unwrap_or(0);
        assert!(rb.starts_with("held") && waited >= 800, "process B is refused after the wait: {rb}");
        assert!(matches!(a.0.try_wait(), Ok(None)), "A is still alive — it held the lock the whole time");
        // A endet regulär; C übernimmt.
        std::fs::write(&release, b"go").unwrap();
        assert!(wait_exit(&mut a, Duration::from_secs(30)).success());
        let mut c = spawn_kid("try", &d.join("lock"), &d.join("c.out"), 0, None);
        assert!(wait_exit(&mut c, Duration::from_secs(30)).success());
        let rc = wait_for_report(&d.join("c.out"), Duration::from_secs(5));
        assert!(rc.starts_with("acquired"), "process C takes over after A ended: {rc}");
        // Wirklich getrennte Prozesse: drei Kinder, drei Kennungen, keine davon die der Eltern.
        let pid = |r: &str| r.split("pid=").nth(1).map(str::trim).unwrap_or("").to_string();
        let me = std::process::id().to_string();
        let pids = [pid(&ra), pid(&rb), pid(&rc)];
        assert!(pids.iter().all(|p| !p.is_empty() && *p != me), "children are other processes than the test itself: {pids:?}");
        assert!(pids[0] != pids[1] && pids[1] != pids[2] && pids[0] != pids[2], "A, B and C are three processes: {pids:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn separate_processes_a_crashed_holder_frees_the_lock() {
        let d = tmp("xcrash");
        std::fs::create_dir_all(&d).unwrap();
        let mut a = spawn_kid("hold", &d.join("lock"), &d.join("a.out"), 60_000, None);
        let ra = wait_for_report(&d.join("a.out"), Duration::from_secs(30));
        assert!(ra.starts_with("acquired"), "process A holds the lock: {ra}");
        // Absturz: hart beendet (TerminateProcess), nichts räumt auf.
        a.0.kill().unwrap();
        let st = wait_exit(&mut a, Duration::from_secs(30));
        assert!(!st.success(), "A was killed, not ended normally");
        assert!(lock_path(&d.join("lock")).exists(), "the lock FILE is left behind");
        let mut c = spawn_kid("try", &d.join("lock"), &d.join("c.out"), 0, None);
        assert!(wait_exit(&mut c, Duration::from_secs(30)).success());
        let rc = wait_for_report(&d.join("c.out"), Duration::from_secs(5));
        assert!(rc.starts_with("acquired"), "after the crash a new process gets the lock — the file alone locks nothing: {rc}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn separate_processes_restart_waits_for_the_old_one() {
        let d = tmp("xrestart");
        std::fs::create_dir_all(&d).unwrap();
        // A hält 1,5 s und endet dann von selbst — wie die alte Kopie beim Neustart.
        let mut a = spawn_kid("hold", &d.join("lock"), &d.join("a.out"), 1_500, None);
        let ra = wait_for_report(&d.join("a.out"), Duration::from_secs(30));
        assert!(ra.starts_with("acquired"), "old process A holds the lock: {ra}");
        // B startet sofort und wartet mit der echten Neustart-Frist.
        let mut b = spawn_kid("wait", &d.join("lock"), &d.join("b.out"), RELAUNCH_WAIT.as_millis() as u64, None);
        assert!(wait_exit(&mut b, Duration::from_secs(30)).success());
        let rb = wait_for_report(&d.join("b.out"), Duration::from_secs(5));
        let waited: u64 = rb.split_whitespace().nth(1).and_then(|v| v.parse().ok()).unwrap_or(0);
        assert!(rb.starts_with("acquired"), "new process B takes over once the old one is gone: {rb}");
        assert!(waited >= 500 && waited < RELAUNCH_WAIT.as_millis() as u64, "B really waited for A, within the relaunch window: {rb}");
        assert!(wait_exit(&mut a, Duration::from_secs(30)).success(), "A ended on its own");
        let _ = std::fs::remove_dir_all(&d);
    }

    // ── Verdrahtung beim Start (Quelltext) ─────────────────────────────────

    #[test]
    fn startup_takes_the_lock_first_holds_it_for_life_and_fails_closed() {
        let lib = include_str!("lib.rs");
        let setup = lib.find(".setup(|app| {").expect("setup closure");
        let lock = lib[setup..].find("instance_lock::acquire_waiting(").map(|i| i + setup).expect("setup takes the instance lock");
        let first_run = lib.find("data_root::resolve_or_first_run(&locator_dir)").expect("first-run check");
        let plugin = lib.find("tauri_plugin_single_instance::init(").expect("single-instance plugin stays");
        assert!(plugin < setup && lock < first_run, "lock is taken in setup BEFORE any data-root decision, DB or server");
        let block = &lib[setup..first_run];
        assert!(block.contains("app_local_data_dir()"), "the lock lives in the local AppData, not in the control or data folder");
        // Lebensdauer: der Griff geht in den Tauri-Zustand (bleibt bis Prozessende) — und nirgends wieder heraus.
        assert!(block.contains("app.manage(InstanceLockState(lock));"), "the lock is held for the life of the process");
        assert_eq!(lib.matches("InstanceLockState(").count(), 2, "only declared and managed — never taken out again");
        assert!(!lib.contains("unmanage"), "nothing removes managed state");
        // Fail-closed: beide Fehler beenden den Prozess, bevor irgendetwas geöffnet wird.
        let held = block.find("LockError::HeldByAnotherProcess").expect("held branch");
        let io = block.find("LockError::Io(e)").expect("technical-failure branch");
        assert!(block[held..io].contains("std::process::exit(0)"), "already running → message and exit");
        assert!(block[io..].contains("std::process::exit(1)") && block[io..].contains("lock_setup_failed_message"),
            "safety lock not available → message and exit, no start without the lock");
        assert!(!block.contains("starting without"), "there is no start without the lock any more");
    }
}
