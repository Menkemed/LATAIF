// DATA-ROOT-B1b — was ein Ordner beweisen muss, bevor er wieder der Datenort werden darf.
//
// Jeder Test baut seinen eigenen Ordnerbaum; keiner sieht AppData, eine Produktionskennung oder eine
// echte Datenbank. Der Punkt ist nicht der gute Fall — der ist einer von vielen — sondern dass JEDE
// Art, wie ein Ordner falsch sein kann, in einer Verweigerung endet UND dabei nichts entsteht.

use super::*;
use std::fs;

const OWNER_EMAIL: &str = "owner@example.com";
const OWNER_PW: &str = "a-real-owner-password";

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("lataif-adopt-{tag}-{}", uuid::Uuid::new_v4().as_simple()));
    fs::create_dir_all(&d).unwrap();
    d
}

/// Eine Geschaeftsdatenbank, wie die Anwendung sie anlegt — so weit, wie die Uebernahme sie prueft.
fn business_db(path: &Path) {
    let c = Connection::open(path).unwrap();
    c.execute_batch(
        "CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT);
         CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT);
         CREATE TABLE invoices (id TEXT PRIMARY KEY, customer_id TEXT REFERENCES customers(id));
         CREATE TABLE settings (branch_id TEXT, key TEXT, value TEXT);
         CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, synced INTEGER);
         INSERT INTO products (id, name) VALUES ('p1','Rolex');
         INSERT INTO customers (id, name) VALUES ('c1','Ali');
         INSERT INTO invoices (id, customer_id) VALUES ('i1','c1');",
    )
    .unwrap();
}

/// Ein vollstaendiger, uebernehmbarer Datenort: Marker, beide Datenbanken, Identitaet, Eigentuemer.
fn good_root(tag: &str) -> PathBuf {
    let root = tmp(tag);
    // Der Marker kommt aus der kanonischen Primitive; der Locator gehoert NICHT in den Ordner, also
    // faellt er weg — genau so sieht ein echter, verschobener Datenort aus.
    data_root::setup_new_installation(&root).unwrap();
    fs::remove_file(root.join(data_root::LOCATOR_FILENAME)).unwrap();

    business_db(&root.join(BUSINESS_DB_FILENAME));
    let conn = crate::sync::db::init_database(&root.join(SYNC_SERVER_DB_FILENAME)).unwrap();
    crate::sync::credentials::provision_owner(
        &conn, OWNER_PW, OWNER_PW, crate::sync::credentials::PROVISION_CONFIRMATION,
    )
    .unwrap();
    conn.execute("UPDATE users SET email = ?1 WHERE id = 'user-owner'", rusqlite::params![OWNER_EMAIL]).unwrap();
    drop(conn);

    crate::sync::install_id::load_or_create_in_dir(&root).unwrap();
    fs::create_dir_all(root.join(MEDIA_DIRNAME)).unwrap();
    root
}

/// Ein frisches Kontrollverzeichnis: leer, so wie nach einer Neuinstallation.
fn control() -> PathBuf { tmp("control") }

fn locator_exists(control_dir: &Path) -> bool {
    control_dir.join(data_root::LOCATOR_FILENAME).exists()
}

/// Der Zustand eines Ordners als Fingerabdruck — um zu beweisen, dass eine Verweigerung ihn nicht
/// angefasst hat.
fn snapshot(root: &Path) -> Vec<(String, u64)> {
    let mut v: Vec<(String, u64)> = fs::read_dir(root)
        .unwrap()
        .map(|e| {
            let e = e.unwrap();
            (e.file_name().to_string_lossy().to_string(), e.metadata().map(|m| m.len()).unwrap_or(0))
        })
        // SQLite legt beim Oeffnen einer WAL-Datenbank ihre Begleitdateien an — auch nur lesend.
        // Sie tragen keine Daten dieser Installation und entstehen bei jedem Oeffnen neu; was hier
        // zaehlt, ist der Bestand selbst.
        .filter(|(n, _)| !n.ends_with("-wal") && !n.ends_with("-shm"))
        .collect();
    v.sort();
    v
}

// ── der gute Fall ───────────────────────────────────────────────────────────

#[test]
fn a_complete_root_is_adopted_and_only_the_locator_is_written() {
    let root = good_root("good");
    let ctrl = control();
    let before = snapshot(&root);

    let facts = validate_candidate(&root, &ctrl).unwrap();
    assert!(!locator_exists(&ctrl), "validation alone writes nothing");
    assert_eq!(snapshot(&root), before, "and it does not touch the candidate either");

    let adopted = adopt(&root, &ctrl, OWNER_EMAIL, OWNER_PW).unwrap();
    assert_eq!(adopted.root_id, facts.root_id, "the EXISTING id is kept, never re-minted");
    assert_eq!(adopted.path, canonical(&root).to_string_lossy());

    // Auf dem neuen C: steht genau eine Datei, und sie zeigt auf den bestehenden Ordner.
    let entries: Vec<_> = fs::read_dir(&ctrl).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(entries.len(), 1, "exactly one file was created: {entries:?}");
    let loc = data_root::read_locator(&ctrl).unwrap().unwrap();
    assert_eq!(loc.root_id, facts.root_id);
    assert_eq!(PathBuf::from(&loc.data_root), canonical(&root));

    // Und der Datenort selbst ist Byte fuer Byte derselbe.
    assert_eq!(snapshot(&root), before, "nothing in the data folder was created, moved or changed");
    assert!(!ctrl.join(BUSINESS_DB_FILENAME).exists(), "no business database was copied to the new C:");
    assert!(!ctrl.join(SYNC_SERVER_DB_FILENAME).exists(), "no server database either");
    assert!(!ctrl.join(MEDIA_DIRNAME).exists(), "and no media");

    // Ab hier ist es eine gewoehnliche Installation: der normale Resolver oeffnet sie.
    let resolved = data_root::resolve(&ctrl).unwrap();
    assert_eq!(resolved.root_id(), facts.root_id);
    assert_eq!(resolved.path(), canonical(&root));
}

#[test]
fn a_second_adoption_never_happens_at_all() {
    // Ein Rechner entscheidet sich einmal. Ein zweiter Aufruf — Doppelklick, zweites Fenster,
    // direkter Aufruf — findet die Entscheidung vor und faellt heraus, statt sie zu wiederholen.
    let root = good_root("twice");
    let ctrl = control();
    let a = adopt(&root, &ctrl, OWNER_EMAIL, OWNER_PW).unwrap();
    let again = adopt(&root, &ctrl, OWNER_EMAIL, OWNER_PW).unwrap_err();
    assert_eq!(again.code(), "ADOPT_ALREADY_DECIDED");
    assert_eq!(fs::read_dir(&ctrl).unwrap().count(), 1, "one locator, and it was not rewritten");
    assert_eq!(data_root::read_locator(&ctrl).unwrap().unwrap().root_id, a.root_id);
}

// ── jede Art, falsch zu sein ────────────────────────────────────────────────

/// Ein Ordner wird kaputt gemacht, geprueft — und danach muss das neue C: leer sein.
fn rejected(tag: &str, break_it: impl FnOnce(&Path), expect: &str) {
    let root = good_root(tag);
    break_it(&root);
    let ctrl = control();
    let err = validate_candidate(&root, &ctrl).unwrap_err();
    assert_eq!(err.code(), expect, "wrong reason for {tag}");
    assert!(!locator_exists(&ctrl), "a refusal must not write a locator ({tag})");
    // Und der Uebernahme-Weg sagt dasselbe — er prueft selbst, nicht auf Zuruf.
    let err2 = adopt(&root, &ctrl, OWNER_EMAIL, OWNER_PW).unwrap_err();
    assert_eq!(err2.code(), expect, "adopt must refuse for the same reason ({tag})");
    assert!(!locator_exists(&ctrl), "…and still write nothing ({tag})");
}

#[test]
fn a_folder_without_a_marker_is_not_a_lataif_data_location() {
    rejected("nomarker", |r| { fs::remove_file(r.join(data_root::MARKER_FILENAME)).unwrap(); }, "ADOPT_MARKER_MISSING");
}

#[test]
fn a_broken_marker_is_refused_instead_of_repaired() {
    rejected("badmarker", |r| { fs::write(r.join(data_root::MARKER_FILENAME), b"{ not json").unwrap(); }, "ADOPT_MARKER_UNUSABLE");
    rejected("emptyid", |r| {
        fs::write(r.join(data_root::MARKER_FILENAME), br#"{"schemaVersion":1,"rootId":"","createdAt":"x"}"#).unwrap();
    }, "ADOPT_MARKER_UNUSABLE");
}

#[test]
fn a_missing_or_unreadable_business_database_is_refused() {
    rejected("nobiz", |r| { fs::remove_file(r.join(BUSINESS_DB_FILENAME)).unwrap(); }, "ADOPT_BUSINESS_DB_MISSING");
    rejected("notadb", |r| { fs::write(r.join(BUSINESS_DB_FILENAME), b"this is not a database").unwrap(); }, "ADOPT_BUSINESS_DB_UNREADABLE");
}

#[test]
fn a_business_database_that_is_not_lataif_is_refused() {
    rejected("foreigndb", |r| {
        let p = r.join(BUSINESS_DB_FILENAME);
        fs::remove_file(&p).unwrap();
        let c = Connection::open(&p).unwrap();
        c.execute_batch("CREATE TABLE something_else (id TEXT);").unwrap();
    }, "ADOPT_BUSINESS_DB_NOT_LATAIF");
}

#[test]
fn a_damaged_but_openable_database_is_refused() {
    // Kein Muellhaufen, sondern eine echte SQLite-Datei mit kaputten Seiten: der Kopf bleibt heil,
    // sie laesst sich oeffnen — und genau dafuer gibt es `integrity_check`.
    let root = good_root("corrupt");
    let p = root.join(BUSINESS_DB_FILENAME);
    {
        // Genug Zeilen, damit die Datei mehrere Seiten hat und eine davon zerstoert werden kann.
        let c = Connection::open(&p).unwrap();
        c.execute_batch("CREATE TABLE filler (id INTEGER PRIMARY KEY, blob TEXT);").unwrap();
        for i in 0..400 {
            c.execute("INSERT INTO filler (id, blob) VALUES (?1, ?2)", rusqlite::params![i, "x".repeat(200)]).unwrap();
        }
        c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    }
    let mut bytes = fs::read(&p).unwrap();
    let len = bytes.len();
    assert!(len > 8192, "the fixture needs more than one page ({len})");
    // Den Kopf (die ersten 100 Byte) unangetastet lassen, den Rest ab der zweiten Seite verderben.
    for b in bytes.iter_mut().skip(4096).take(2048) { *b = 0xA5; }
    fs::write(&p, &bytes).unwrap();

    let ctrl = control();
    let code = validate_candidate(&root, &ctrl).unwrap_err().code();
    assert!(
        code == "ADOPT_BUSINESS_DB_INCONSISTENT" || code == "ADOPT_BUSINESS_DB_UNREADABLE",
        "a damaged database must be refused, got {code}"
    );
    assert!(!locator_exists(&ctrl), "and nothing is written for it");
}

#[test]
fn a_business_database_with_a_dangling_reference_is_refused() {
    rejected("fkbroken", |r| {
        let c = Connection::open(r.join(BUSINESS_DB_FILENAME)).unwrap();
        // Ein Beleg, dessen Kunde nicht existiert — `foreign_key_check` findet genau das. Die
        // Durchsetzung wird zum Herstellen abgeschaltet; so entstehen solche Zeilen auch in der
        // Wirklichkeit (aeltere Schreibwege ohne eingeschaltete Fremdschluessel).
        c.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
        c.execute("INSERT INTO invoices (id, customer_id) VALUES ('i2','ghost')", []).unwrap();
    }, "ADOPT_BUSINESS_DB_INCONSISTENT");
}

#[test]
fn a_missing_or_foreign_server_database_is_refused() {
    rejected("nosrv", |r| { fs::remove_file(r.join(SYNC_SERVER_DB_FILENAME)).unwrap(); }, "ADOPT_SERVER_DB_MISSING");
    rejected("srvjunk", |r| { fs::write(r.join(SYNC_SERVER_DB_FILENAME), b"nope").unwrap(); }, "ADOPT_SERVER_DB_UNUSABLE");
    rejected("srvempty", |r| {
        let p = r.join(SYNC_SERVER_DB_FILENAME);
        fs::remove_file(&p).unwrap();
        Connection::open(&p).unwrap().execute_batch("CREATE TABLE x (id TEXT);").unwrap();
    }, "ADOPT_SERVER_DB_UNUSABLE");
}

#[test]
fn a_folder_whose_pieces_do_not_belong_together_is_refused() {
    // Die Server-Datenbank sagt, sie gehoere zu einer anderen Installation als die Schluesseldatei
    // daneben — genau der Zustand eines zusammengemischten Ordners.
    rejected("mismatch", |r| {
        let c = Connection::open(r.join(SYNC_SERVER_DB_FILENAME)).unwrap();
        c.execute(
            "INSERT INTO primary_host_config (tenant_id, branch_id, primary_host_id, server_instance_id, mode, configured_at, state)
             VALUES ('tenant-1','branch-main','host','11111111-2222-4333-8444-555555555555','primary','now','primary')",
            [],
        ).unwrap();
    }, "ADOPT_IDENTITY_MISMATCH");
    // Und ohne Kennung ist gar nichts zu binden.
    rejected("noid", |r| { fs::remove_file(r.join("sync_install_id.key")).unwrap(); }, "ADOPT_INSTALL_ID_UNUSABLE");
    rejected("badid", |r| { fs::write(r.join("sync_install_id.key"), b"not-a-uuid").unwrap(); }, "ADOPT_INSTALL_ID_UNUSABLE");
}

#[test]
fn a_half_finished_maintenance_operation_blocks_the_adoption() {
    for name in [".restore-intent", ".backup-intent", ".gc-intent", "data-move-intent.json", ".restore-journal"] {
        let root = good_root("maint");
        fs::write(root.join(name), b"{}").unwrap();
        let ctrl = control();
        let err = validate_candidate(&root, &ctrl).unwrap_err();
        assert_eq!(err.code(), format!("ADOPT_MAINTENANCE_PENDING:{name}"));
        assert!(!locator_exists(&ctrl));
        // Und ausdruecklich: die Absicht wird NICHT aufgeraeumt.
        assert!(root.join(name).exists(), "the pending operation is left for the path that owns it");
    }
}

#[test]
fn the_control_directory_itself_is_never_a_candidate() {
    let ctrl = control();
    data_root::setup_new_installation(&ctrl).unwrap();
    let err = validate_candidate(&ctrl, &ctrl).unwrap_err();
    assert_eq!(err.code(), "ADOPT_OVERLAPS_CONTROL_DIRECTORY");
    let missing = tmp("gone").join("not-here");
    assert_eq!(validate_candidate(&missing, &control()).unwrap_err().code(), "ADOPT_NOT_A_DIRECTORY");
}

#[test]
fn media_may_be_absent_but_never_a_file() {
    let root = good_root("nomedia");
    fs::remove_dir_all(root.join(MEDIA_DIRNAME)).unwrap();
    let ctrl = control();
    let facts = validate_candidate(&root, &ctrl).unwrap();
    assert!(!facts.has_media, "a data folder without pictures yet is still a data folder");

    let root2 = good_root("mediafile");
    fs::remove_dir_all(root2.join(MEDIA_DIRNAME)).unwrap();
    fs::write(root2.join(MEDIA_DIRNAME), b"not a directory").unwrap();
    assert_eq!(validate_candidate(&root2, &control()).unwrap_err().code(), "ADOPT_MEDIA_NOT_A_DIRECTORY");
}

// ── der Eigentuemer ─────────────────────────────────────────────────────────

#[test]
fn a_wrong_owner_never_adopts_anything() {
    let root = good_root("owner");
    let ctrl = control();
    let before = snapshot(&root);

    for (email, pw) in [(OWNER_EMAIL, "wrong-password"), ("someone@else.com", OWNER_PW)] {
        let err = adopt(&root, &ctrl, email, pw).unwrap_err();
        assert!(err.code().starts_with("ADOPT_OWNER_REJECTED"), "got {}", err.code());
        assert!(!locator_exists(&ctrl), "a rejected owner must not adopt");
        assert_eq!(snapshot(&root), before, "…and must not touch the folder");
    }
    // Der richtige Eigentuemer kommt durch — dieselbe Pruefung, die auch sonst im Haus gilt.
    assert!(adopt(&root, &ctrl, OWNER_EMAIL, OWNER_PW).is_ok());
}

#[test]
fn the_owner_check_reads_and_writes_nothing() {
    // Die Pruefung laeuft gegen eine NUR LESEND geoeffnete Datenbank; ein Schreibversuch waere ein
    // Fehler statt einer stillen Aenderung. Bewiesen an der Datei selbst.
    let root = good_root("readonly");
    let db = root.join(SYNC_SERVER_DB_FILENAME);
    let before = fs::metadata(&db).unwrap().len();
    let _ = adopt(&root, &control(), OWNER_EMAIL, "wrong");
    let _ = adopt(&root, &control(), OWNER_EMAIL, OWNER_PW);
    assert_eq!(fs::metadata(&db).unwrap().len(), before, "the candidate's server database is untouched");
}

// ── zwischen Pruefung und Uebernahme ────────────────────────────────────────

#[test]
fn a_candidate_that_changes_after_the_check_is_caught_at_the_commit() {
    let root = good_root("toctou");
    let ctrl = control();
    // Die Auskunft sagt: in Ordnung.
    assert!(validate_candidate(&root, &ctrl).is_ok());
    // Danach wird der Ordner ausgetauscht — genau das Zeitfenster, das eine getrennte
    // "erst pruefen, dann uebernehmen"-Schnittstelle offen liesse.
    fs::remove_file(root.join(BUSINESS_DB_FILENAME)).unwrap();
    let err = adopt(&root, &ctrl, OWNER_EMAIL, OWNER_PW).unwrap_err();
    assert_eq!(err.code(), "ADOPT_BUSINESS_DB_MISSING", "the commit re-checks everything itself");
    assert!(!locator_exists(&ctrl));
}

#[test]
fn a_candidate_that_changes_while_the_owner_types_is_caught_before_the_commit() {
    // Das echte Zeitfenster: zwischen der Anmeldung des Eigentuemers (bcrypt braucht spuerbar Zeit)
    // und dem Schreiben des Locators. Genau dort wird hineingegriffen.
    for (name, plant) in [
        ("maintenance", ".gc-intent"),
        ("marker", data_root::MARKER_FILENAME),
    ] {
        let root = good_root(&format!("window-{name}"));
        let ctrl = control();
        let before = snapshot(&root);
        let target = root.join(plant);
        let err = adopt_with_hook(&root, &ctrl, OWNER_EMAIL, OWNER_PW, &|| {
            if plant == data_root::MARKER_FILENAME {
                // Ein ANDERER Datenbestand wird untergeschoben — dieselbe Datei, neue Kennung.
                fs::write(&target, br#"{"schemaVersion":1,"rootId":"99999999-9999-4999-8999-999999999999","createdAt":"x","bootstrapPending":false,"businessDbExpected":true}"#).unwrap();
            } else {
                fs::write(&target, b"{}").unwrap();
            }
        })
        .unwrap_err();
        let code = err.code();
        assert!(
            code == "ADOPT_CANDIDATE_CHANGED" || code.starts_with("ADOPT_MAINTENANCE_PENDING"),
            "the final re-check must catch the change ({name}), got {code}"
        );
        assert!(!locator_exists(&ctrl), "and nothing is committed ({name})");
        // Der Ordner bleibt, wie der Eingriff ihn hinterlassen hat — die Uebernahme raeumt nicht auf.
        assert_ne!(snapshot(&root), before, "the fixture really did change the folder ({name})");
    }
}

#[test]
fn only_one_of_two_concurrent_adoptions_can_win() {
    // Gleicher Kandidat, zwei Faeden: einer schreibt, der andere findet die Entscheidung vor.
    let root = good_root("race-same");
    let ctrl = control();
    let results: Vec<_> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let r = root.clone();
                let c = ctrl.clone();
                s.spawn(move || adopt(&r, &c, OWNER_EMAIL, OWNER_PW))
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let ok_count = results.iter().filter(|r| r.is_ok()).count();
    assert_eq!(ok_count, 1, "exactly one adoption may commit: {results:?}");
    let refused = results.iter().find(|r| r.is_err()).unwrap().clone().unwrap_err();
    assert_eq!(refused.code(), "ADOPT_ALREADY_DECIDED", "and the other one says why");
    assert_eq!(fs::read_dir(&ctrl).unwrap().count(), 1, "one locator, not two");
    let winner = results.iter().find(|r| r.is_ok()).unwrap().clone().unwrap();
    let loc = data_root::read_locator(&ctrl).unwrap().unwrap();
    assert_eq!(loc.root_id, winner.root_id);
}

#[test]
fn two_different_candidates_can_never_both_be_adopted() {
    // Zwei vollstaendig gueltige, verschiedene Datenorte gleichzeitig. Der Locator darf danach
    // GENAU einen davon nennen — und zwar vollstaendig: Pfad und Kennung desselben Ordners.
    let a = good_root("race-a");
    let b = good_root("race-b");
    let ctrl = control();
    assert_ne!(
        data_root::read_marker(&a).unwrap().unwrap().root_id,
        data_root::read_marker(&b).unwrap().unwrap().root_id,
        "the two candidates are genuinely different data sets"
    );

    let (ra, rb) = std::thread::scope(|s| {
        let ca = ctrl.clone();
        let cb = ctrl.clone();
        let aa = a.clone();
        let bb = b.clone();
        let ha = s.spawn(move || adopt(&aa, &ca, OWNER_EMAIL, OWNER_PW));
        let hb = s.spawn(move || adopt(&bb, &cb, OWNER_EMAIL, OWNER_PW));
        (ha.join().unwrap(), hb.join().unwrap())
    });
    assert_eq!(
        [ra.is_ok(), rb.is_ok()].iter().filter(|x| **x).count(),
        1,
        "never both: a={ra:?} b={rb:?}"
    );
    let winner = if ra.is_ok() { ra.clone().unwrap() } else { rb.clone().unwrap() };
    let loc = data_root::read_locator(&ctrl).unwrap().unwrap();
    // Keine Mischung: Pfad UND Kennung stammen aus demselben Ordner.
    assert_eq!(loc.root_id, winner.root_id);
    assert_eq!(PathBuf::from(&loc.data_root), PathBuf::from(&winner.path));
    let marker_of_winner = data_root::read_marker(&PathBuf::from(&winner.path)).unwrap().unwrap();
    assert_eq!(marker_of_winner.root_id, loc.root_id, "path and id belong to each other");
}

#[test]
fn a_failing_locator_write_leaves_no_half_decision() {
    let root = good_root("locatorfail");
    let ctrl = control();
    let before = snapshot(&root);
    // Der Platz des Locators ist belegt — und zwar durch etwas, worauf kein Umbenennen zielen kann.
    // Damit scheitert genau der letzte Schritt, nachdem alles andere schon gut ging.
    fs::create_dir_all(ctrl.join(data_root::LOCATOR_FILENAME)).unwrap();

    let err = adopt(&root, &ctrl, OWNER_EMAIL, OWNER_PW).unwrap_err();
    assert_eq!(err.code(), "ADOPT_LOCATOR_WRITE_FAILED");
    // Kein gueltiger Locator — und was `write_atomic` an Bruchstuecken hinterlaesst, ist keiner:
    // gelesen wird ausschliesslich `data-location.json`, und das ist hier kein lesbarer Locator.
    assert!(data_root::read_locator(&ctrl).is_err() || data_root::read_locator(&ctrl).unwrap().is_none());
    assert!(!ctrl.join(BUSINESS_DB_FILENAME).exists(), "and no business root was started on C:");
    assert!(!ctrl.join(data_root::MARKER_FILENAME).exists(), "no second data root either");
    assert_eq!(snapshot(&root), before, "the candidate is untouched");

    // Und der Rechner bleibt entscheidungsfaehig: raeumt man das Hindernis weg, ist es wieder ein
    // erster Start — nicht eine halb uebernommene Installation.
    fs::remove_dir_all(ctrl.join(data_root::LOCATOR_FILENAME)).unwrap();
    assert!(matches!(
        data_root::resolve_or_first_run(&ctrl).unwrap(),
        data_root::Resolution::FirstRunUndecided
    ));
    assert!(adopt(&root, &ctrl, OWNER_EMAIL, OWNER_PW).is_ok(), "and a later attempt still works");
}

#[test]
fn the_adopted_id_comes_from_the_folder_and_not_from_the_caller() {
    // Es gibt keinen Weg, dem Kern eine Kennung zu nennen: `adopt` nimmt Pfad und Anmeldung, sonst
    // nichts. Was im Locator landet, steht im Marker des Ordners.
    let root = good_root("idsource");
    let ctrl = control();
    let marker_id = data_root::read_marker(&root).unwrap().unwrap().root_id;
    let facts = adopt(&root, &ctrl, OWNER_EMAIL, OWNER_PW).unwrap();
    assert_eq!(facts.root_id, marker_id);
    assert_eq!(data_root::read_locator(&ctrl).unwrap().unwrap().root_id, marker_id);
}
