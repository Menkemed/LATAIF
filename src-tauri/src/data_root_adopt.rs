// DATA-ROOT-B1b — einen bestehenden Datenort wieder in Betrieb nehmen.
//
// Der Fall, um den es geht: `C:` ist weg, neu aufgesetzt, LATAIF neu installiert — und `E:\LATAIF\Data`
// liegt vollstaendig da. Die Erstlauf-Weiche (B1a) hat nichts angelegt und fragt. Hier ist die zweite
// Antwort: der Benutzer zeigt selbst auf den Ordner, dieser wird vollstaendig geprueft, der Eigentuemer
// weist sich aus, und dann entsteht auf dem neuen `C:` genau EINE Datei — der Locator.
//
// ## Was hier nicht passiert
//
// Es wird nichts gesucht. Kein Laufwerk wird abgeklappert, kein Pfad geraten, kein zuletzt bekannter
// Ort probiert. Es wird nichts kopiert: die Geschaeftsdatenbank, die Server-Datenbank und die Medien
// bleiben, wo sie sind, und werden bis zum Schluss nur GELESEN. Es entsteht keine zweite Wurzel, keine
// neue `rootId`, keine neue Geraeteidentitaet und kein neues Geheimnis.
//
// ## Warum die Pruefung zweimal laeuft
//
// Die Oberflaeche darf fragen, ob ein Ordner taugt — aber ihre Antwort ist nur eine Auskunft. Der
// Uebernahme-Aufruf prueft ALLES selbst noch einmal, unmittelbar bevor er den Locator schreibt. Damit
// gibt es kein Zeitfenster zwischen "geprueft" und "uebernommen", in dem jemand den Ordner austauschen
// koennte, und der Kern glaubt dem Bildschirm nichts ausser dem Pfad und dem Passwort.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

use crate::data_root::{
    self, BUSINESS_DB_FILENAME, MEDIA_DIRNAME, SYNC_SERVER_DB_FILENAME,
};

/// Warum ein Ordner nicht uebernommen werden kann. Jede Variante ist ein eigener, nennbarer Grund —
/// "geht nicht" waere fuer den, der seine Daten sucht, keine Hilfe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdoptError {
    /// Der Pfad existiert nicht oder ist kein Verzeichnis.
    NotADirectory,
    /// Der Kandidat IST das Kontrollverzeichnis oder ueberlappt damit.
    OverlapsControlDirectory,
    /// Kein Wurzel-Marker: das ist kein LATAIF-Datenordner.
    MarkerMissing,
    /// Marker unlesbar, unbekannte Version oder ohne Kennung.
    MarkerUnusable,
    /// Die Geschaeftsdatenbank fehlt.
    BusinessDbMissing,
    /// Die Geschaeftsdatenbank ist keine oeffenbare SQLite-Datei.
    BusinessDbUnreadable,
    /// `PRAGMA integrity_check` / `foreign_key_check` schlagen an.
    BusinessDbInconsistent,
    /// Eine erwartete Kerntabelle fehlt — das ist keine LATAIF-Datenbank.
    BusinessDbNotLataif,
    /// Die Server-Datenbank fehlt.
    ServerDbMissing,
    /// Server-Datenbank unlesbar, inkonsistent oder ohne die erwarteten Tabellen.
    ServerDbUnusable,
    /// Die Installationskennung fehlt oder ist unbrauchbar.
    InstallIdUnusable,
    /// Die Server-Datenbank ist an eine ANDERE Installation gebunden als die Kennung im Ordner.
    IdentityMismatch,
    /// `media/` existiert, ist aber kein Verzeichnis.
    MediaNotADirectory,
    /// Im Ordner liegt eine begonnene Wartungsoperation.
    MaintenancePending(&'static str),
    /// Die Eigentuemer-Anmeldung wurde nicht bestaetigt.
    OwnerRejected(&'static str),
    /// Der Locator liess sich nicht schreiben.
    LocatorWriteFailed(String),
}

impl AdoptError {
    pub fn code(&self) -> String {
        match self {
            AdoptError::NotADirectory => "ADOPT_NOT_A_DIRECTORY".into(),
            AdoptError::OverlapsControlDirectory => "ADOPT_OVERLAPS_CONTROL_DIRECTORY".into(),
            AdoptError::MarkerMissing => "ADOPT_MARKER_MISSING".into(),
            AdoptError::MarkerUnusable => "ADOPT_MARKER_UNUSABLE".into(),
            AdoptError::BusinessDbMissing => "ADOPT_BUSINESS_DB_MISSING".into(),
            AdoptError::BusinessDbUnreadable => "ADOPT_BUSINESS_DB_UNREADABLE".into(),
            AdoptError::BusinessDbInconsistent => "ADOPT_BUSINESS_DB_INCONSISTENT".into(),
            AdoptError::BusinessDbNotLataif => "ADOPT_BUSINESS_DB_NOT_LATAIF".into(),
            AdoptError::ServerDbMissing => "ADOPT_SERVER_DB_MISSING".into(),
            AdoptError::ServerDbUnusable => "ADOPT_SERVER_DB_UNUSABLE".into(),
            AdoptError::InstallIdUnusable => "ADOPT_INSTALL_ID_UNUSABLE".into(),
            AdoptError::IdentityMismatch => "ADOPT_IDENTITY_MISMATCH".into(),
            AdoptError::MediaNotADirectory => "ADOPT_MEDIA_NOT_A_DIRECTORY".into(),
            AdoptError::MaintenancePending(f) => format!("ADOPT_MAINTENANCE_PENDING:{f}"),
            AdoptError::OwnerRejected(c) => format!("ADOPT_OWNER_REJECTED:{c}"),
            AdoptError::LocatorWriteFailed(_) => "ADOPT_LOCATOR_WRITE_FAILED".into(),
        }
    }
}

/// Was ein geprueter Ordner ueber sich preisgibt — genug, um ihn zu erkennen, nichts Geheimes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateFacts {
    /// Der kanonische Pfad, auf den der Locator zeigen wird.
    pub path: String,
    /// Die BESTEHENDE Kennung des Ordners. Sie wird nie neu erzeugt.
    pub root_id: String,
    /// Der oeffentliche Name der Installation — dieselbe Einwegableitung wie im Sync.
    pub server_fingerprint: String,
    pub has_media: bool,
}

/// Eine begonnene Wartungsoperation im Ordner macht ihn unantastbar, bis sie zu Ende gefuehrt ist.
///
/// Die Namen kommen aus den bestehenden Vertraegen (Restore, Backup, GC, Move) — hier wird nichts
/// erfunden und ausdruecklich nichts aufgeraeumt: eine halbe Operation gehoert dem Weg, der sie
/// begonnen hat, nicht der Uebernahme.
const MAINTENANCE_MARKERS: &[&str] = &[
    ".restore-intent",
    ".restore-journal",
    ".restore-staging",
    ".restore-rollback",
    ".backup-intent",
    ".gc-intent",
    data_root::LOCATOR_FILENAME, // ein Locator IM Ordner ist eine tote Kopie eines fruehen Moves
    "data-move-intent.json",
];

fn canonical(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Alles pruefen, was ohne einen einzigen Schreibvorgang pruefbar ist.
///
/// Reihenfolge ist Absicht: erst der Pfad, dann der Marker, dann die Datenbanken, dann die
/// Identitaet, zuletzt die Wartungslage. Wer frueh scheitert, erfaehrt den einfachen Grund.
pub fn validate_candidate(candidate: &Path, control_dir: &Path) -> Result<CandidateFacts, AdoptError> {
    // 1. Der Pfad. `paths_overlap` ist dieselbe Windows-feste Pruefung, die auch der Move benutzt:
    //    Gross-/Kleinschreibung, `..`, und "der eine liegt im anderen".
    if !candidate.is_dir() {
        return Err(AdoptError::NotADirectory);
    }
    let root = canonical(candidate);
    if data_root::paths_overlap(&root, control_dir) {
        return Err(AdoptError::OverlapsControlDirectory);
    }

    // 2. Der Marker — die Kennung des Ordners. Sie wird gelesen, nie erzeugt.
    let marker = match data_root::read_marker(&root) {
        Ok(Some(m)) => m,
        Ok(None) => return Err(AdoptError::MarkerMissing),
        Err(_) => return Err(AdoptError::MarkerUnusable),
    };
    if marker.root_id.trim().is_empty() {
        return Err(AdoptError::MarkerUnusable);
    }

    // 3. Die Geschaeftsdatenbank — nur lesend geoeffnet, und sie muss wirklich gesund sein.
    let biz = root.join(BUSINESS_DB_FILENAME);
    if !biz.is_file() {
        return Err(AdoptError::BusinessDbMissing);
    }
    check_business_db(&biz)?;

    // 4. Die Server-Datenbank und die Identitaet dieser Installation.
    let srv = root.join(SYNC_SERVER_DB_FILENAME);
    if !srv.is_file() {
        return Err(AdoptError::ServerDbMissing);
    }
    check_server_db(&srv)?;
    let install_id = read_install_id(&root)?;
    check_identity(&srv, &install_id)?;

    // 5. Medien. Ein Ordner ohne `media/` ist in Ordnung — die Anwendung legt es an, sobald das
    //    erste Bild kommt. Etwas, das `media` heisst und kein Verzeichnis ist, ist es nicht.
    let media = root.join(MEDIA_DIRNAME);
    let has_media = media.is_dir();
    if media.exists() && !has_media {
        return Err(AdoptError::MediaNotADirectory);
    }

    // 6. Wartungslage. Zuletzt, weil sie am ehesten voruebergehend ist.
    for name in MAINTENANCE_MARKERS {
        if root.join(name).exists() {
            return Err(AdoptError::MaintenancePending(name));
        }
    }

    Ok(CandidateFacts {
        path: root.to_string_lossy().to_string(),
        root_id: marker.root_id,
        server_fingerprint: crate::sync::install_id::public_fingerprint(&install_id),
        has_media,
    })
}

fn open_read_only(path: &Path) -> Result<Connection, ()> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| ())
}

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?1",
        rusqlite::params![name],
        |_| Ok(()),
    )
    .is_ok()
}

/// Kerntabellen, die jede LATAIF-Geschaeftsdatenbank hat. Nicht die ganze Liste — die waechst mit
/// jedem Slice — sondern die, ohne die der Begriff "Geschaeftsdatenbank" nichts bedeutet.
const BUSINESS_CORE_TABLES: &[&str] = &["products", "customers", "invoices", "settings", "sync_changelog"];
/// Dasselbe fuer die Server-Datenbank: Identitaet, Rechte, Log.
const SERVER_CORE_TABLES: &[&str] = &["users", "user_branches", "primary_host_config", "sync_changelog"];

fn check_business_db(path: &Path) -> Result<(), AdoptError> {
    let conn = open_read_only(path).map_err(|_| AdoptError::BusinessDbUnreadable)?;
    // Eine Datei, die nur zufaellig auf `.db` endet, faellt schon hier durch.
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|_| AdoptError::BusinessDbUnreadable)?;
    if integrity != "ok" {
        return Err(AdoptError::BusinessDbInconsistent);
    }
    // Ein Fremdschluessel, der ins Leere zeigt, ist ein halber Datenbestand — und der wird nicht
    // uebernommen, sondern benannt.
    let mut stmt = conn
        .prepare("PRAGMA foreign_key_check")
        .map_err(|_| AdoptError::BusinessDbUnreadable)?;
    let violations = stmt
        .query_map([], |_| Ok(()))
        .map_err(|_| AdoptError::BusinessDbUnreadable)?
        .count();
    if violations > 0 {
        return Err(AdoptError::BusinessDbInconsistent);
    }
    for t in BUSINESS_CORE_TABLES {
        if !table_exists(&conn, t) {
            return Err(AdoptError::BusinessDbNotLataif);
        }
    }
    Ok(())
}

fn check_server_db(path: &Path) -> Result<(), AdoptError> {
    let conn = open_read_only(path).map_err(|_| AdoptError::ServerDbUnusable)?;
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|_| AdoptError::ServerDbUnusable)?;
    if integrity != "ok" {
        return Err(AdoptError::ServerDbUnusable);
    }
    for t in SERVER_CORE_TABLES {
        if !table_exists(&conn, t) {
            return Err(AdoptError::ServerDbUnusable);
        }
    }
    Ok(())
}

/// Die Installationskennung LESEN — niemals anlegen. `load_or_create_in_dir` wuerde hier eine neue
/// Identitaet erfinden, und genau das darf eine Pruefung nicht.
fn read_install_id(root: &Path) -> Result<String, AdoptError> {
    let p = root.join("sync_install_id.key");
    let raw = std::fs::read_to_string(&p).map_err(|_| AdoptError::InstallIdUnusable)?;
    crate::sync::install_id::parse_install_id(&raw).map_err(|_| AdoptError::InstallIdUnusable)
}

/// Die staerkste Bindung, die es in einem historischen Ordner wirklich gibt: die Server-Datenbank
/// merkt sich, zu welcher Installation sie gehoert. Steht dort eine andere Kennung als in der
/// Schluesseldatei daneben, ist der Ordner zusammengemischt — genau die Pruefung, mit der der
/// Server auch eine kopierte Datenbank erkennt.
fn check_identity(server_db: &Path, install_id: &str) -> Result<(), AdoptError> {
    let conn = open_read_only(server_db).map_err(|_| AdoptError::ServerDbUnusable)?;
    let bound: Option<String> = conn
        .query_row(
            "SELECT server_instance_id FROM primary_host_config
              WHERE server_instance_id IS NOT NULL AND TRIM(server_instance_id) <> ''
              LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok();
    match bound {
        // Noch nie als Primary eingerichtet: es gibt nichts, was widersprechen koennte.
        None => Ok(()),
        Some(id) if id == install_id => Ok(()),
        Some(_) => Err(AdoptError::IdentityMismatch),
    }
}

/// Den Eigentuemer gegen die Server-Datenbank DES KANDIDATEN pruefen.
///
/// `authorize_owner` ist der bestehende Vertrag des Hauses und rein lesend: zwei SELECTs und ein
/// bcrypt-Vergleich, kein Zaehler, kein Zeitstempel, keine Spur. Deshalb darf er hier laufen, ohne
/// dass die Pruefung ihren "es wird nichts geschrieben"-Charakter verliert.
fn check_owner(server_db: &Path, email: &str, password: &str) -> Result<(), AdoptError> {
    let conn = open_read_only(server_db).map_err(|_| AdoptError::ServerDbUnusable)?;
    crate::sync::primary::authorize_owner(&conn, "tenant-1", "branch-main", email, password)
        .map(|_| ())
        .map_err(AdoptError::OwnerRejected)
}

/// Den Ordner uebernehmen — der einzige Schreibvorgang dieses Weges.
///
/// Er prueft ALLES noch einmal selbst, unmittelbar bevor er schreibt. Was die Oberflaeche vorher
/// gesehen hat, spielt keine Rolle: zwischen einer Auskunft und einer Uebernahme kann ein Ordner
/// ausgetauscht, ein Laufwerk abgezogen oder eine Wartung begonnen worden sein. Vertraut wird dem
/// Bildschirm nur der Pfad und das Passwort — die Kennung kommt aus dem Marker, nie aus dem Aufruf.
pub fn adopt(
    candidate: &Path,
    control_dir: &Path,
    email: &str,
    password: &str,
) -> Result<CandidateFacts, AdoptError> {
    let facts = validate_candidate(candidate, control_dir)?;
    let root = PathBuf::from(&facts.path);
    check_owner(&root.join(SYNC_SERVER_DB_FILENAME), email, password)?;

    // Auf einem frisch aufgesetzten Rechner gibt es das Kontrollverzeichnis noch gar nicht — es
    // entsteht sonst erst beim Bootstrap, den es hier ja gerade nicht gibt. Es anzulegen ist keine
    // Entscheidung ueber Daten: es ist der Ort, an den der Locator gehoert.
    std::fs::create_dir_all(control_dir)
        .map_err(|e| AdoptError::LocatorWriteFailed(e.to_string()))?;
    // Der Commit-Punkt: eine Datei, atomar geschrieben (temp → fsync → rename), mit der BESTEHENDEN
    // Kennung. Schlaegt das fehl, bleibt kein halber Locator liegen und der Ordner ist unberuehrt.
    data_root::set_locator(control_dir, &root, &facts.root_id)
        .map_err(|e| AdoptError::LocatorWriteFailed(e.code().to_string()))?;
    Ok(facts)
}

#[cfg(test)]
#[path = "data_root_adopt_tests.rs"]
mod data_root_adopt_tests;
